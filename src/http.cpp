#include "http.hpp"

#include <algorithm>
#include <atomic>
#include <cctype>
#include <chrono>
#include <cstring>
#include <fstream>
#include <sstream>
#include <thread>
#include <vector>

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
typedef SOCKET socket_t;
#define CLOSESOCK closesocket
#define INVALID_SOCK INVALID_SOCKET
#else
#include <arpa/inet.h>
#include <netdb.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <unistd.h>
typedef int socket_t;
#define CLOSESOCK ::close
#define INVALID_SOCK (-1)
#endif

namespace http {

namespace {
std::atomic<bool> g_running{false};

#ifdef _WIN32
void ensure_winsock() {
  static bool inited = false;
  if (!inited) {
    WSADATA w;
    WSAStartup(MAKEWORD(2, 2), &w);
    inited = true;
  }
}
#endif

std::string lower(std::string s) {
  for (char& c : s) c = (char)tolower((unsigned char)c);
  return s;
}
std::string trim(const std::string& s) {
  size_t a = 0, b = s.size();
  while (a < b && isspace((unsigned char)s[a])) ++a;
  while (b > a && isspace((unsigned char)s[b - 1])) --b;
  return s.substr(a, b - a);
}

const char* reason_for(int status) {
  switch (status) {
    case 200: return "OK";
    case 204: return "No Content";
    case 400: return "Bad Request";
    case 404: return "Not Found";
    case 405: return "Method Not Allowed";
    case 413: return "Payload Too Large";
    case 500: return "Internal Server Error";
    default: return "OK";
  }
}

std::string content_type_for(const std::string& path) {
  auto dot = path.rfind('.');
  std::string ext = dot == std::string::npos ? "" : lower(path.substr(dot + 1));
  if (ext == "html" || ext == "htm") return "text/html; charset=utf-8";
  if (ext == "js") return "application/javascript; charset=utf-8";
  if (ext == "css") return "text/css; charset=utf-8";
  if (ext == "json") return "application/json; charset=utf-8";
  if (ext == "svg") return "image/svg+xml";
  if (ext == "png") return "image/png";
  if (ext == "ico") return "image/x-icon";
  if (ext == "txt") return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

bool read_file(const std::string& path, std::string& out) {
  std::ifstream f(path, std::ios::binary);
  if (!f) return false;
  std::stringstream ss;
  ss << f.rdbuf();
  out = ss.str();
  return true;
}

bool send_all(socket_t s, const std::string& data) {
  size_t off = 0;
  while (off < data.size()) {
    int n = (int)::send(s, data.data() + off, (int)(data.size() - off), 0);
    if (n <= 0) return false;
    off += (size_t)n;
  }
  return true;
}

std::string build_response(const Response& resp) {
  std::string r = "HTTP/1.1 " + std::to_string(resp.status) + " " + reason_for(resp.status) + "\r\n";
  r += "Content-Type: " + resp.content_type + "\r\n";
  r += "Content-Length: " + std::to_string(resp.body.size()) + "\r\n";
  r += "Connection: close\r\n";
  r += "Cache-Control: no-store\r\n";
  r += "X-Content-Type-Options: nosniff\r\n";
  r += "\r\n";
  r += resp.body;
  return r;
}

bool handle_client(socket_t client, const std::string& web_dir, const Handler& handler) {
#ifdef _WIN32
  DWORD tmo = 15000;
  setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, (const char*)&tmo, sizeof tmo);
  setsockopt(client, SOL_SOCKET, SO_SNDTIMEO, (const char*)&tmo, sizeof tmo);
#else
  struct timeval tv;
  tv.tv_sec = 15;
  tv.tv_usec = 0;
  setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
  setsockopt(client, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
#endif
  std::string raw;
  char tmp[8192];
  size_t header_end = std::string::npos;
  size_t sep_len = 0;
  while (true) {
    header_end = raw.find("\r\n\r\n");
    sep_len = 4;
    if (header_end == std::string::npos) {
      header_end = raw.find("\n\n");
      sep_len = 2;
    }
    if (header_end != std::string::npos) break;
    int n = (int)::recv(client, tmp, sizeof tmp, 0);
    if (n <= 0) return false;
    raw.append(tmp, (size_t)n);
    if (raw.size() > 65536) return false;
  }
  std::string head = raw.substr(0, header_end);
  std::string rest = raw.substr(header_end + sep_len);
  Request req;
  {
    size_t eol = head.find("\r\n");
    if (eol == std::string::npos) eol = head.find('\n');
    std::string first = head.substr(0, eol == std::string::npos ? head.size() : eol);
    std::vector<std::string> parts;
    std::string cur;
    for (char c : first) {
      if (c == ' ') { parts.push_back(cur); cur.clear(); }
      else cur += c;
    }
    parts.push_back(cur);
    if (parts.empty() || parts[0].empty()) return false;
    req.method = parts[0];
    req.path = parts.size() >= 2 ? parts[1] : "/";
  }
  size_t content_length = 0;
  {
    size_t pos = 0;
    while (pos < head.size()) {
      size_t e = head.find("\n", pos);
      if (e == std::string::npos) e = head.size();
      std::string line = head.substr(pos, e - pos);
      if (!line.empty() && line.back() == '\r') line.pop_back();
      auto colon = line.find(':');
      if (colon != std::string::npos) {
        std::string name = lower(trim(line.substr(0, colon)));
        std::string val = trim(line.substr(colon + 1));
        if (name == "content-length") {
          try { content_length = (size_t)std::stoul(val); } catch (...) {}
        } else if (name == "host") {
          req.host = val;
        } else if (name == "origin") {
          req.origin = val;
        }
      }
      pos = e + 1;
    }
  }
  if (content_length > 8u * 1024 * 1024) return false;
  while (rest.size() < content_length) {
    int n = (int)::recv(client, tmp, sizeof tmp, 0);
    if (n <= 0) break;
    rest.append(tmp, (size_t)n);
  }
  req.body = rest.substr(0, std::min(rest.size(), content_length));

  Response resp;
  if (req.path.size() >= 5 && req.path.compare(0, 5, "/api/") == 0) {
    handler(req, resp);
  } else {
    std::string path = req.path;
    auto q = path.find('?');
    if (q != std::string::npos) path = path.substr(0, q);
    if (path.empty() || path == "/") path = "/index.html";
    if (path.find("..") != std::string::npos || path.find('\\') != std::string::npos) {
      resp.set_text(400, "bad path");
    } else {
      std::string body;
      if (read_file(web_dir + path, body)) {
        resp.status = 200;
        resp.content_type = content_type_for(path);
        resp.body = body;
      } else {
        resp.set_text(404, "not found");
      }
    }
  }
  std::string out = build_response(resp);
  return send_all(client, out);
}

} // namespace

bool listen(const std::string& bind_host, int port, intptr_t& out_fd, int& out_port, std::string& err) {
  err.clear();
#ifdef _WIN32
  ensure_winsock();
#endif
  struct addrinfo hints;
  memset(&hints, 0, sizeof hints);
  hints.ai_family = AF_UNSPEC;
  hints.ai_socktype = SOCK_STREAM;
  hints.ai_flags = AI_PASSIVE;
  struct addrinfo* res = nullptr;
  std::string port_str = std::to_string(port);
  if (getaddrinfo(bind_host.empty() ? "127.0.0.1" : bind_host.c_str(), port_str.c_str(), &hints, &res) != 0) {
    err = "getaddrinfo failed";
    return false;
  }
  socket_t s = INVALID_SOCK;
  for (struct addrinfo* ai = res; ai; ai = ai->ai_next) {
    s = ::socket(ai->ai_family, ai->ai_socktype, ai->ai_protocol);
    if (s == INVALID_SOCK) continue;
    int one = 1;
    setsockopt(s, SOL_SOCKET, SO_REUSEADDR, (const char*)&one, sizeof one);
#ifdef _WIN32
    if (::bind(s, ai->ai_addr, (int)ai->ai_addrlen) == 0) break;
#else
    if (::bind(s, ai->ai_addr, ai->ai_addrlen) == 0) break;
#endif
    CLOSESOCK(s);
    s = INVALID_SOCK;
  }
  freeaddrinfo(res);
  if (s == INVALID_SOCK) {
    err = "无法绑定端口 " + std::to_string(port) + "（可能已被占用）";
    return false;
  }
  if (::listen(s, 32) != 0) {
    CLOSESOCK(s);
    err = "listen failed";
    return false;
  }
  // query actual port
  sockaddr_storage ss;
  socklen_t sl = sizeof ss;
  if (getsockname(s, (sockaddr*)&ss, &sl) == 0) {
    if (ss.ss_family == AF_INET) {
      out_port = ntohs(((sockaddr_in*)&ss)->sin_port);
    } else if (ss.ss_family == AF_INET6) {
      out_port = ntohs(((sockaddr_in6*)&ss)->sin6_port);
    }
  } else {
    out_port = port;
  }
  out_fd = (intptr_t)s;
  g_running = true;
  return true;
}

void run_loop(intptr_t listen_fd, const std::string& web_dir, const Handler& handler) {
  socket_t server = (socket_t)listen_fd;
  while (g_running) {
    sockaddr_storage from;
    socklen_t fl = sizeof from;
    socket_t client = ::accept(server, (sockaddr*)&from, &fl);
    if (client == INVALID_SOCK) {
      if (!g_running) break;
      std::this_thread::sleep_for(std::chrono::milliseconds(50));
      continue;
    }
    std::thread([client, web_dir, handler]() {
      handle_client(client, web_dir, handler);
      CLOSESOCK(client);
    }).detach();
  }
}

void shutdown(intptr_t listen_fd) {
  g_running = false;
  if (listen_fd >= 0) CLOSESOCK((socket_t)listen_fd);
}

} // namespace http