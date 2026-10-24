#include "proto.hpp"

#include <algorithm>
#include <cctype>
#include <cerrno>
#include <cstdlib>
#include <cstring>
#include <sstream>

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
#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <unistd.h>
typedef int socket_t;
#define CLOSESOCK ::close
#define INVALID_SOCK (-1)
#endif

#ifdef HAS_OPENSSL
#include <openssl/err.h>
#include <openssl/ssl.h>
#include <openssl/x509_vfy.h> // X509_VERIFY_PARAM_set_hostflags
#include <openssl/x509v3.h>   // X509_CHECK_FLAG_NO_PARTIAL_WILDCARDS（3.x 起定义在 x509v3.h）
#endif

#include "util.hpp"

namespace proto {

#ifdef _WIN32
static void ensure_winsock() {
  static bool inited = false;
  if (!inited) {
    WSADATA w;
    WSAStartup(MAKEWORD(2, 2), &w);
    inited = true;
  }
}
#endif

bool Net::has_tls() {
#ifdef HAS_OPENSSL
  return true;
#else
  return false;
#endif
}

#ifdef HAS_OPENSSL
static SSL_CTX* tls_ctx() {
  static SSL_CTX* ctx = nullptr;
  if (!ctx) {
    SSL_library_init();
    SSL_load_error_strings();
    OpenSSL_add_all_algorithms();
    ctx = SSL_CTX_new(TLS_client_method());
    if (ctx) {
      SSL_CTX_set_options(ctx, SSL_OP_NO_SSLv2 | SSL_OP_NO_SSLv3 | SSL_OP_NO_TLSv1 | SSL_OP_NO_TLSv1_1);
      SSL_CTX_set_verify(ctx, SSL_VERIFY_PEER, nullptr);
      SSL_CTX_set_default_verify_paths(ctx);
    }
  }
  return ctx;
}

// 配置 TLS 连接的主机名校验（SNI + 证书主机名）。
// 原实现只做证书链校验（SSL_VERIFY_PEER），不做主机名校验：
// 中间人只要有一张任意合法 CA 签发的证书就能通过握手，
// 即使证书的域名与所连服务器完全无关。这里补上 X509_VERIFY_PARAM_set1_host。
static bool ssl_setup_host(SSL* s, const std::string& host) {
  if (host.empty()) return false;
  if (SSL_set_tlsext_host_name(s, host.c_str()) != 1) return false;  // SNI
  X509_VERIFY_PARAM* param = SSL_get0_param(s);
  if (!param) return false;
  X509_VERIFY_PARAM_set_hostflags(param, X509_CHECK_FLAG_NO_PARTIAL_WILDCARDS);
  // 0 = 不附加 NUL，按 host 全名匹配证书 SAN/CN
  return X509_VERIFY_PARAM_set1_host(param, host.c_str(), 0) == 1;
}
#endif

bool Net::starttls(const std::string& host) {
#ifdef HAS_OPENSSL
  if (tls || fd < 0) return false;
  SSL_CTX* ctx = tls_ctx();
  if (!ctx) { last_error_ = "无法创建 TLS 上下文"; return false; }
  SSL* s = SSL_new(ctx);
  if (!s) { last_error_ = "无法创建 TLS 连接对象"; return false; }
  if (!ssl_setup_host(s, host)) {
    SSL_free(s);
    last_error_ = std::string("TLS 主机名设置失败（host 为空？）：") + host;
    return false;
  }
  SSL_set_fd(s, (int)fd);
  if (SSL_connect(s) != 1) {
    unsigned long e = ERR_get_error();
    char ebuf[256] = {0};
    if (e) ERR_error_string_n(e, ebuf, sizeof ebuf);
    SSL_free(s);
    last_error_ = std::string("STARTTLS 握手失败（证书校验不通过等）：") + (ebuf[0] ? ebuf : "unknown");
    return false;
  }
  this->ssl = s;
  tls = true;
  return true;
#else
  last_error_ = "本程序未编译 TLS 支持";
  return false;
#endif
}

bool Net::connect(const std::string& host, int port, bool use_tls, int timeout_ms) {
  close();
  last_error_.clear();
  if (use_tls && !has_tls()) {
    last_error_ = "本程序未编译 TLS 支持";
    return false;
  }
#ifdef _WIN32
  ensure_winsock();
#endif
  struct addrinfo hints;
  memset(&hints, 0, sizeof hints);
  hints.ai_family = AF_UNSPEC;
  hints.ai_socktype = SOCK_STREAM;
  const std::string port_str = std::to_string(port);
  struct addrinfo* res = nullptr;
  if (getaddrinfo(host.c_str(), port_str.c_str(), &hints, &res) != 0) {
    last_error_ = "域名解析失败（DNS 查不到 " + host + "，检查主机名或换 DNS）";
    return false;
  }
  socket_t s = INVALID_SOCK;
  std::string tried;
  for (struct addrinfo* ai = res; ai; ai = ai->ai_next) {
    char ip[INET6_ADDRSTRLEN] = {0};
    const void* addr = (ai->ai_family == AF_INET)
                           ? (const void*)&((struct sockaddr_in*)ai->ai_addr)->sin_addr
                           : (const void*)&((struct sockaddr_in6*)ai->ai_addr)->sin6_addr;
    inet_ntop(ai->ai_family, addr, ip, sizeof ip);
    if (!tried.empty()) tried += ", ";
    tried += std::string(ip) + (ai->ai_family == AF_INET6 ? "(v6)" : "");
    s = ::socket(ai->ai_family, ai->ai_socktype, ai->ai_protocol);
    if (s == INVALID_SOCK) continue;

    // 非阻塞 connect + select 带超时。
    // 原实现直接阻塞 connect：SO_RCVTIMEO/SO_SNDTIMEO 只作用于 recv/send，
    // 对黑洞/被防火墙 DROP 的地址，阻塞 connect 最长可达数分钟，
    // 使轮询线程长时间卡死（timeout_ms 形同虚设）。
#ifdef _WIN32
    u_long nb = 1;
    ioctlsocket(s, FIONBIO, &nb);
#else
    int fl = fcntl(s, F_GETFL, 0);
    fcntl(s, F_SETFL, fl | O_NONBLOCK);
#endif
    int cr = ::connect(s, ai->ai_addr, (int)ai->ai_addrlen);
    bool connect_ok = (cr == 0);
    if (!connect_ok) {
#ifdef _WIN32
      int werr = WSAGetLastError();
      if (werr == WSAEWOULDBLOCK || werr == WSAEINPROGRESS) {
#else
      if (errno == EINPROGRESS || errno == EWOULDBLOCK) {
#endif
        fd_set wset;
        FD_ZERO(&wset);
        FD_SET((socket_t)s, &wset);
        struct timeval ct;
        ct.tv_sec = timeout_ms / 1000;
        ct.tv_usec = (timeout_ms % 1000) * 1000;
        int sr = select((int)s + 1, nullptr, &wset, nullptr, &ct);
        if (sr > 0 && FD_ISSET((socket_t)s, &wset)) {
          int soerr = 0;
#ifdef _WIN32
          int slen = (int)sizeof soerr;
#else
          socklen_t slen = (socklen_t)sizeof soerr;
#endif
          if (getsockopt(s, SOL_SOCKET, SO_ERROR, (char*)&soerr, &slen) == 0 && soerr == 0) {
            connect_ok = true;
          }
        }
      }
    }
#ifdef _WIN32
    u_long blk = 0;
    ioctlsocket(s, FIONBIO, &blk);
#else
    fcntl(s, F_SETFL, fl);
#endif
    if (connect_ok) break;
    CLOSESOCK(s);
    s = INVALID_SOCK;
  } // for (struct addrinfo* ai = res; ...)
  freeaddrinfo(res);
  if (s == INVALID_SOCK) {
    last_error_ = "TCP 连接失败：已尝试 " + tried + " 的 " + port_str +
                  " 端口，全部不通（端口可能被防火墙/校园网拦截，或该服务未开放，或连接超时）";
    return false;
  }
  fd = (intptr_t)s;
#ifdef _WIN32
  DWORD tmo = (DWORD)timeout_ms;
  setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, (const char*)&tmo, sizeof tmo);
  setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, (const char*)&tmo, sizeof tmo);
#else
  struct timeval tv;
  tv.tv_sec = timeout_ms / 1000;
  tv.tv_usec = (timeout_ms % 1000) * 1000;
  setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
  setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
#endif
  if (use_tls) {
#ifdef HAS_OPENSSL
    SSL_CTX* ctx = tls_ctx();
    if (!ctx) { last_error_ = "无法创建 TLS 上下文"; return false; }
    SSL* ssl = SSL_new(ctx);
    if (!ssl) { last_error_ = "无法创建 TLS 连接对象"; return false; }
    if (!ssl_setup_host(ssl, host)) {
      SSL_free(ssl);
      close();
      last_error_ = "TLS 主机名设置失败";
      return false;
    }
    SSL_set_fd(ssl, (int)s);
    if (SSL_connect(ssl) != 1) {
      unsigned long e = ERR_get_error();
      char ebuf[256] = {0};
      if (e) ERR_error_string_n(e, ebuf, sizeof ebuf);
      SSL_free(ssl);
      close();
      last_error_ = std::string("TLS 握手失败（端口不是 SSL 端口，或证书校验不通过）") +
                    (ebuf[0] ? std::string("：") + ebuf : "");
      return false;
    }
    this->ssl = ssl;
    tls = true;
#else
    close();
    last_error_ = "本程序未编译 TLS 支持";
    return false;
#endif
  }
  return true;
}

int Net::raw_recv(char* p, int n) {
  if (tls && ssl) {
#ifdef HAS_OPENSSL
    int r = SSL_read((SSL*)ssl, p, n);
    return r > 0 ? r : -1;
#else
    return -1;
#endif
  }
  int r = (int)::recv((socket_t)fd, p, n, 0);
  return r > 0 ? r : -1;
}

bool Net::send_all(const std::string& data) {
  size_t off = 0;
  while (off < data.size()) {
    int n;
    if (tls && ssl) {
#ifdef HAS_OPENSSL
      n = SSL_write((SSL*)ssl, data.data() + off, (int)(data.size() - off));
#else
      n = -1;
#endif
    } else {
      n = (int)::send((socket_t)fd, data.data() + off, (int)(data.size() - off), 0);
    }
    if (n <= 0) return false;
    off += (size_t)n;
  }
  return true;
}

bool Net::recv_line(std::string& line) {
  for (;;) {
    size_t p = buf.find('\n');
    if (p != std::string::npos) {
      line = buf.substr(0, p);
      buf.erase(0, p + 1);
      if (!line.empty() && line.back() == '\r') line.pop_back();
      return true;
    }
    char tmp[4096];
    int n = raw_recv(tmp, sizeof tmp);
    if (n <= 0) return false;
    buf.append(tmp, (size_t)n);
  }
}

bool Net::recv_exact(std::string& out, size_t n) {
  while (out.size() < n) {
    if (!buf.empty()) {
      size_t take = std::min(n - out.size(), buf.size());
      out.append(buf.data(), take);
      buf.erase(0, take);
      continue;
    }
    char tmp[8192];
    int r = raw_recv(tmp, sizeof tmp);
    if (r <= 0) return false;
    buf.append(tmp, (size_t)r);
  }
  return true;
}

void Net::close() {
  if (ssl) {
#ifdef HAS_OPENSSL
    SSL_free((SSL*)ssl);
#endif
    ssl = nullptr;
  }
  if (fd >= 0) {
    CLOSESOCK((socket_t)fd);
    fd = -1;
  }
  tls = false;
  buf.clear();
}

namespace {

bool read_response(Net& net, int& code, std::string& text) {
  std::string line;
  if (!net.recv_line(line)) return false;
  if (line.size() < 3) {
    text = line;
    return false;
  }
  code = atoi(line.substr(0, 3).c_str());
  text = line;
  while (line.size() >= 4 && line[3] == '-') {
    std::string next;
    if (!net.recv_line(next)) return false;
    text += "\n" + next;
    line = next;
  }
  return true;
}

// SMTP EHLO，返回能力字符串（用于识别 STARTTLS）
bool smtp_ehlo(Net& net, std::string& caps) {
  int code;
  std::string text;
  if (!net.send_all("EHLO email-chatter.local\r\n")) return false;
  if (!read_response(net, code, text) || code != 250) return false;
  caps = text;
  return true;
}

// 若服务器通告 STARTTLS 且当前连接未加密，则升级为 TLS（587/25 常用）
bool smtp_maybe_starttls(Net& net, const SmtpConfig& cfg, const std::string& caps,
                         std::string& err) {
  if (cfg.ssl || caps.find("STARTTLS") == std::string::npos) return true;
  int code;
  std::string text;
  if (!net.send_all("STARTTLS\r\n")) { err = "SMTP STARTTLS 发送失败"; return false; }
  if (!read_response(net, code, text) || code != 220) { err = "SMTP STARTTLS 被拒绝: " + text; return false; }
  if (!net.starttls(cfg.host)) { err = "SMTP " + net.last_error(); return false; }
  if (!smtp_ehlo(net, text)) { err = "SMTP EHLO（加密后）失败"; return false; }
  return true;
}

} // namespace

bool smtp_send(const SmtpConfig& cfg, const std::string& to_addr, const std::string& subject,
               const std::string& body, std::string& err) {
  err.clear();
  if (cfg.host.empty()) { err = "SMTP 服务器未配置"; return false; }
  SmtpConfig c = cfg;
  bool want_tls = cfg.ssl;
  Net net;
  if (!net.connect(c.host, c.port, want_tls, 20000)) {
    // 配置为 SSL 但握手失败（常见于把 587/25/110/143 明文端口误勾了 SSL）：
    // 自动回退为明文连接 + STARTTLS 升级，保证功能可用且不降安全（升级后同样校验证书主机名）。
    if (want_tls && net.last_error().find("TLS 握手失败") != std::string::npos) {
      want_tls = false;
      c.ssl = false;
      if (!net.connect(c.host, c.port, false, 20000)) {
        err = "无法连接 SMTP 服务器 " + c.host + ":" + std::to_string(c.port) + "：" + net.last_error();
        return false;
      }
    } else {
      err = "无法连接 SMTP 服务器 " + c.host + ":" + std::to_string(c.port) + "：" + net.last_error();
      return false;
    }
  }
  int code = 0;
  std::string text;
  if (!read_response(net, code, text) || code != 220) {
    err = "SMTP 问候失败: " + text;
    return false;
  }
  if (!smtp_ehlo(net, text)) { err = "SMTP EHLO 失败: " + text; return false; }
  if (!smtp_maybe_starttls(net, c, text, err)) return false;

  bool authed = false;
  // AUTH LOGIN
  if (net.send_all("AUTH LOGIN\r\n")) {
    if (read_response(net, code, text) && code == 334) {
      if (net.send_all(util::b64_encode(c.user) + "\r\n") && read_response(net, code, text) && code == 334) {
        if (net.send_all(util::b64_encode(c.pass) + "\r\n") && read_response(net, code, text) && code == 235) {
          authed = true;
        }
      }
    }
  }
  if (!authed) {
    // AUTH PLAIN
    std::string plain = std::string(1, '\0') + c.user + std::string(1, '\0') + c.pass;
    if (net.send_all("AUTH PLAIN " + util::b64_encode(plain) + "\r\n")) {
      if (read_response(net, code, text) && code == 235) authed = true;
    }
  }
  if (!authed) {
    err = "SMTP 认证失败（请检查邮箱地址与客户端授权密码）: " + text;
    return false;
  }

  const std::string from = c.from_addr.empty() ? c.user : c.from_addr;
  // SMTP 命令与信封同样做注入防护：地址里不允许 CR/LF
  const std::string from_safe = util::sanitize_header(from);
  const std::string to_safe = util::sanitize_header(to_addr);
  if (!net.send_all("MAIL FROM:<" + from_safe + ">\r\n")) { err = "SMTP MAIL FROM 失败"; return false; }
  if (!read_response(net, code, text) || code != 250) { err = "SMTP MAIL FROM 被拒绝: " + text; return false; }
  if (!net.send_all("RCPT TO:<" + to_safe + ">\r\n")) { err = "SMTP RCPT TO 失败"; return false; }
  if (!read_response(net, code, text) || (code != 250 && code != 251)) { err = "SMTP RCPT TO 被拒绝: " + text; return false; }
  if (!net.send_all("DATA\r\n")) { err = "SMTP DATA 失败"; return false; }
  if (!read_response(net, code, text) || code != 354) { err = "SMTP DATA 未接受: " + text; return false; }

  std::string msg = mime::build_message(c.display_name, from, to_addr, subject, body);
  std::string data;
  size_t start = 0;
  while (start < msg.size()) {
    size_t e = msg.find('\n', start);
    std::string line = (e == std::string::npos) ? msg.substr(start) : msg.substr(start, e - start);
    if (!line.empty() && line.back() == '\r') line.pop_back();
    if (!line.empty() && line[0] == '.') line = "." + line;
    data += line + "\r\n";
    if (e == std::string::npos) break;
    start = e + 1;
  }
  data += ".\r\n";
  if (!net.send_all(data)) { err = "SMTP 发送邮件内容失败"; return false; }
  if (!read_response(net, code, text) || code != 250) { err = "SMTP 邮件未被服务器接受: " + text; return false; }
  net.send_all("QUIT\r\n");
  return true;
}

FetchResult pop3_fetch(const Pop3Config& cfg, const std::set<std::string>& seen_uidls, int max_new) {
  FetchResult res;
  if (cfg.host.empty()) { res.error = "POP3 服务器未配置"; return res; }
  bool want_tls = cfg.ssl;
  Net net;
  if (!net.connect(cfg.host, cfg.port, want_tls, 20000)) {
    if (want_tls && net.last_error().find("TLS 握手失败") != std::string::npos) {
      want_tls = false;
      if (!net.connect(cfg.host, cfg.port, false, 20000)) {
        res.error = "无法连接 POP3 服务器 " + cfg.host + ":" + std::to_string(cfg.port) + "：" + net.last_error();
        return res;
      }
    } else {
      res.error = "无法连接 POP3 服务器 " + cfg.host + ":" + std::to_string(cfg.port) + "：" + net.last_error();
      return res;
    }
  }
  std::string line;
  if (!net.recv_line(line) || !util::starts_with(line, "+OK")) { res.error = "POP3 问候失败"; return res; }
  if (!want_tls) {
    // POP3 STLS：服务器通告后升级加密（110 端口常用）
    std::string caps;
    if (net.send_all("CAPA\r\n") && net.recv_line(caps) && util::starts_with(caps, "+OK")) {
      std::string l;
      bool has_stls = false;
      while (true) {
        if (!net.recv_line(l)) break;
        if (l == ".") break;
        if (l == "STLS") has_stls = true;
      }
      if (has_stls) {
        net.send_all("STLS\r\n");
        if (net.recv_line(l) && util::starts_with(l, "+OK")) {
          if (!net.starttls(cfg.host)) { res.error = "POP3 " + net.last_error(); return res; }
        }
      }
    }
  }
  if (!net.send_all("USER " + util::sanitize_header(cfg.user) + "\r\n")) { res.error = "POP3 USER 发送失败"; return res; }
  if (!net.recv_line(line) || !util::starts_with(line, "+OK")) { res.error = "POP3 用户名被拒绝"; return res; }
  if (!net.send_all("PASS " + util::sanitize_header(cfg.pass) + "\r\n")) { res.error = "POP3 PASS 发送失败"; return res; }
  if (!net.recv_line(line) || !util::starts_with(line, "+OK")) {
    res.error = "POP3 认证失败（请检查邮箱地址与客户端授权密码）";
    return res;
  }
  if (!net.send_all("UIDL\r\n")) { res.error = "POP3 UIDL 失败"; return res; }
  if (!net.recv_line(line) || !util::starts_with(line, "+OK")) { res.error = "POP3 不支持 UIDL"; return res; }
  std::vector<std::pair<std::string, std::string>> uidl; // (index, uid)
  for (;;) {
    if (!net.recv_line(line)) { res.error = "POP3 UIDL 读取中断"; return res; }
    if (line == ".") break;
    std::vector<std::string> p = util::split(line, ' ');
    if (p.size() >= 2 && !p[0].empty()) uidl.emplace_back(p[0], p[1]);
  }
  for (const auto& kv : uidl) {
    if (seen_uidls.count(kv.second)) continue;
    if ((int)res.messages.size() >= max_new) break;  // 单轮上限，剩余的下一轮再取
    if (!net.send_all("RETR " + kv.first + "\r\n")) { res.error = "POP3 RETR 发送失败"; return res; }
    if (!net.recv_line(line) || !util::starts_with(line, "+OK")) continue; // skip broken message
    std::string raw;
    for (;;) {
      if (!net.recv_line(line)) { res.error = "POP3 RETR 读取中断"; return res; }
      if (line == ".") break;
      if (!line.empty() && line[0] == '.') line = line.substr(1);
      raw += line + "\r\n";
    }
    mime::Msg m;
    mime::parse_message(raw, m);
    res.messages.push_back(m);
    res.new_keys.push_back(kv.second);
  }
  net.send_all("QUIT\r\n");
  res.ok = true;
  return res;
}

namespace {

std::string imap_quote(const std::string& s) {
  std::string out = "\"";
  for (char c : s) {
    if (c == '\\' || c == '"') out += '\\';
    out += c;
  }
  out += '"';
  return out;
}

bool imap_read_until(Net& net, const std::string& tag, std::string& status, std::vector<std::string>* untagged) {
  std::string line;
  for (;;) {
    if (!net.recv_line(line)) return false;
    if (util::starts_with(line, tag + " ")) {
      std::vector<std::string> p = util::split(line, ' ');
      status = p.size() >= 2 ? p[1] : "";
      return true;
    }
    if (untagged) untagged->push_back(line);
  }
}

bool imap_fetch_one(Net& net, const std::string& tag, int uid, std::string& raw, std::string& status) {
  // 用 UID FETCH（而不是按序号 FETCH）：序号会随邮箱压缩/删除漂移，
  // UID 在邮箱生命周期内稳定，配合 seen_uid 才能可靠去重/标已读。
  if (!net.send_all(tag + " UID FETCH " + std::to_string(uid) + " (RFC822)\r\n")) return false;
  raw.clear();
  std::string line;
  for (;;) {
    if (!net.recv_line(line)) return false;
    if (util::starts_with(line, tag + " ")) {
      std::vector<std::string> p = util::split(line, ' ');
      status = p.size() >= 2 ? p[1] : "";
      return true;
    }
    auto lit = line.find("RFC822 {");
    if (lit != std::string::npos) {
      auto close = line.find('}', lit);
      if (close != std::string::npos) {
        size_t n = 0;
        bool ok = true;
        for (size_t k = lit + 8; k < close; ++k) {
          if (!isdigit((unsigned char)line[k])) { ok = false; break; }
          n = n * 10 + (size_t)(line[k] - '0');
        }
        if (ok && n > 0 && n < 50u * 1024 * 1024) {
          std::string lit_data;
          if (!net.recv_exact(lit_data, n)) return false;
          raw = lit_data;
        }
      }
    }
  }
}

} // namespace

FetchResult imap_fetch(const ImapConfig& cfg, const std::set<std::string>& seen_uids, int max_new) {
  FetchResult res;
  if (cfg.host.empty()) { res.error = "IMAP 服务器未配置"; return res; }
  bool want_tls = cfg.ssl;
  Net net;
  if (!net.connect(cfg.host, cfg.port, want_tls, 20000)) {
    if (want_tls && net.last_error().find("TLS 握手失败") != std::string::npos) {
      want_tls = false;
      if (!net.connect(cfg.host, cfg.port, false, 20000)) {
        res.error = "无法连接 IMAP 服务器 " + cfg.host + ":" + std::to_string(cfg.port) + "：" + net.last_error();
        return res;
      }
    } else {
      res.error = "无法连接 IMAP 服务器 " + cfg.host + ":" + std::to_string(cfg.port) + "：" + net.last_error();
      return res;
    }
  }
  std::string line;
  if (!net.recv_line(line) || !util::starts_with(line, "* OK")) {
    res.error = "IMAP 问候失败: " + line;
    return res;
  }
  // 明文连接（143 等）时：若服务器通告 STARTTLS 则升级加密（很多服务端要求加密后才允许 LOGIN）
  if (!want_tls) {
    std::string st;
    std::vector<std::string> u0;
    net.send_all("a0 CAPABILITY\r\n");
    imap_read_until(net, "a0", st, &u0);
    bool has_starttls = false;
    for (const auto& l : u0)
      if (l.find("STARTTLS") != std::string::npos) { has_starttls = true; break; }
    if (has_starttls) {
      net.send_all("a0 STARTTLS\r\n");
      imap_read_until(net, "a0", st, nullptr);
      if (st == "OK") {
        if (!net.starttls(cfg.host)) { res.error = "IMAP " + net.last_error(); return res; }
      }
    }
  }
  // Some providers (NetEase, QQ) require the ID extension before login.
  std::string status;
  net.send_all("a0 ID (\"name\" \"email-chatter\" \"version\" \"1.0\" \"vendor\" \"email-chatter\")\r\n");
  imap_read_until(net, "a0", status, nullptr); // ignore result
  if (!net.send_all("a1 LOGIN " + imap_quote(cfg.user) + " " + imap_quote(cfg.pass) + "\r\n")) {
    res.error = "IMAP LOGIN 发送失败";
    return res;
  }
  std::vector<std::string> untagged;
  if (!imap_read_until(net, "a1", status, &untagged)) { res.error = "IMAP LOGIN 无响应"; return res; }
  if (status != "OK") {
    res.error = "IMAP 认证失败（请检查邮箱地址与客户端授权密码）";
    return res;
  }
  if (!net.send_all("a2 SELECT INBOX\r\n")) { res.error = "IMAP SELECT 发送失败"; return res; }
  untagged.clear();
  if (!imap_read_until(net, "a2", status, &untagged)) { res.error = "IMAP SELECT 无响应"; return res; }
  if (status != "OK") {
    res.error = "IMAP 打开收件箱失败";
    return res;
  }
  // 用 UID SEARCH 而不是 SEARCH：返回的是稳定的 UID。
  // 注意：不带 CHARSET 参数 —— 网易 Coremail 对带 CHARSET 的 UID SEARCH 返回
  // "BAD Could not parse command"，与 phllite(hellopinghe) 的研究结论一致。
  if (!net.send_all("a3 UID SEARCH UNSEEN\r\n")) { res.error = "IMAP SEARCH 发送失败"; return res; }
  untagged.clear();
  if (!imap_read_until(net, "a3", status, &untagged)) { res.error = "IMAP SEARCH 无响应"; return res; }
  if (status != "OK") {
    res.error = "IMAP 搜索未读邮件失败";
    return res;
  }
  std::vector<int> uids;
  for (const auto& l : untagged) {
    if (!util::starts_with(l, "* SEARCH")) continue;
    std::vector<std::string> p = util::split(l, ' ');
    for (size_t k = 2; k < p.size(); ++k) {
      if (!p[k].empty() && isdigit((unsigned char)p[k][0])) uids.push_back(atoi(p[k].c_str()));
    }
  }
  std::set<int> to_mark;
  for (int uid : uids) {
    std::string key = std::to_string(uid);
    if (seen_uids.count(key)) continue;
    if ((int)res.messages.size() >= max_new) break;  // 单轮上限，剩余的下一轮再取
    std::string raw;
    std::string st;
    if (!imap_fetch_one(net, "a4", uid, raw, st)) { res.error = "IMAP FETCH 读取中断"; return res; }
    if (st != "OK" || raw.empty()) continue;
    mime::Msg m;
    mime::parse_message(raw, m);
    res.messages.push_back(m);
    res.new_keys.push_back(key);
    to_mark.insert(uid);
  }
  for (int uid : to_mark) {
    net.send_all("a5 UID STORE " + std::to_string(uid) + " +FLAGS.SILENT (\\Seen)\r\n");
    std::string st;
    imap_read_until(net, "a5", st, nullptr);
  }
  net.send_all("a6 LOGOUT\r\n");
  res.ok = true;
  return res;
}

bool test_smtp(const SmtpConfig& cfg, std::string& err) {
  err.clear();
  if (cfg.host.empty()) { err = "SMTP 服务器未配置"; return false; }
  SmtpConfig c = cfg;
  bool want_tls = cfg.ssl;
  Net net;
  if (!net.connect(c.host, c.port, want_tls, 15000)) {
    if (want_tls && net.last_error().find("TLS 握手失败") != std::string::npos) {
      want_tls = false;
      c.ssl = false;
      if (!net.connect(c.host, c.port, false, 15000)) {
        err = "无法连接 SMTP 服务器 " + c.host + ":" + std::to_string(c.port) + "：" +
              net.last_error() + "（网易企业邮箱用 994+SSL，163/QQ 个人邮箱用 465+SSL）";
        return false;
      }
    } else {
      err = "无法连接 SMTP 服务器 " + c.host + ":" + std::to_string(c.port) + "：" +
            net.last_error() + "（网易企业邮箱用 994+SSL，163/QQ 个人邮箱用 465+SSL）";
      return false;
    }
  }
  int code = 0;
  std::string text;
  if (!read_response(net, code, text) || code != 220) { err = "SMTP 问候失败: " + text; return false; }
  if (!smtp_ehlo(net, text)) { err = "EHLO 失败: " + text; return false; }
  if (!smtp_maybe_starttls(net, c, text, err)) return false;
  bool authed = false;
  if (net.send_all("AUTH LOGIN\r\n") && read_response(net, code, text) && code == 334) {
    if (net.send_all(util::b64_encode(c.user) + "\r\n") && read_response(net, code, text) && code == 334) {
      if (net.send_all(util::b64_encode(c.pass) + "\r\n") && read_response(net, code, text) && code == 235) authed = true;
    }
  }
  if (!authed) {
    std::string plain = std::string(1, '\0') + c.user + std::string(1, '\0') + c.pass;
    if (net.send_all("AUTH PLAIN " + util::b64_encode(plain) + "\r\n") && read_response(net, code, text) && code == 235) authed = true;
  }
  if (!authed) { err = "SMTP 认证失败"; return false; }
  net.send_all("QUIT\r\n");
  return true;
}

bool test_pop3(const Pop3Config& cfg, std::string& err) {
  err.clear();
  if (cfg.host.empty()) { err = "POP3 服务器未配置"; return false; }
  bool want_tls = cfg.ssl;
  Net net;
  if (!net.connect(cfg.host, cfg.port, want_tls, 15000)) {
    if (want_tls && net.last_error().find("TLS 握手失败") != std::string::npos) {
      want_tls = false;
      if (!net.connect(cfg.host, cfg.port, false, 15000)) {
        err = "无法连接 POP3 服务器 " + cfg.host + ":" + std::to_string(cfg.port) + "：" +
              net.last_error() + "（POP3 常用 995+SSL；也可改用 IMAP 993+SSL）";
        return false;
      }
    } else {
      err = "无法连接 POP3 服务器 " + cfg.host + ":" + std::to_string(cfg.port) + "：" +
            net.last_error() + "（POP3 常用 995+SSL；也可改用 IMAP 993+SSL）";
      return false;
    }
  }
  std::string line;
  if (!net.recv_line(line) || !util::starts_with(line, "+OK")) { err = "POP3 问候失败"; return false; }
  if (!want_tls) {
    // POP3 STLS：服务器通告后升级加密（110 端口常用）
    std::string caps;
    if (net.send_all("CAPA\r\n") && net.recv_line(caps) && util::starts_with(caps, "+OK")) {
      std::string l;
      bool has_stls = false;
      while (true) {
        if (!net.recv_line(l)) break;
        if (l == ".") break;
        if (l == "STLS") has_stls = true;
      }
      if (has_stls) {
        net.send_all("STLS\r\n");
        if (net.recv_line(l) && util::starts_with(l, "+OK")) {
          if (!net.starttls(cfg.host)) { err = "POP3 " + net.last_error(); return false; }
        }
      }
    }
  }
  if (!net.send_all("USER " + cfg.user + "\r\n") || !net.recv_line(line) || !util::starts_with(line, "+OK")) {
    err = "POP3 用户名被拒绝";
    return false;
  }
  if (!net.send_all("PASS " + cfg.pass + "\r\n") || !net.recv_line(line) || !util::starts_with(line, "+OK")) {
    err = "POP3 密码被拒绝";
    return false;
  }
  net.send_all("QUIT\r\n");
  return true;
}

bool test_imap(const ImapConfig& cfg, std::string& err) {
  err.clear();
  if (cfg.host.empty()) { err = "IMAP 服务器未配置"; return false; }
  bool want_tls = cfg.ssl;
  Net net;
  if (!net.connect(cfg.host, cfg.port, want_tls, 15000)) {
    if (want_tls && net.last_error().find("TLS 握手失败") != std::string::npos) {
      want_tls = false;
      if (!net.connect(cfg.host, cfg.port, false, 15000)) {
        err = "无法连接 IMAP 服务器 " + cfg.host + ":" + std::to_string(cfg.port) + "：" +
              net.last_error() + "（IMAP 常用 993+SSL）";
        return false;
      }
    } else {
      err = "无法连接 IMAP 服务器 " + cfg.host + ":" + std::to_string(cfg.port) + "：" +
            net.last_error() + "（IMAP 常用 993+SSL）";
      return false;
    }
  }
  std::string line;
  if (!net.recv_line(line) || !util::starts_with(line, "* OK")) { err = "IMAP 问候失败"; return false; }
  if (!want_tls) {
    std::string st;
    std::vector<std::string> u0;
    net.send_all("a0 CAPABILITY\r\n");
    imap_read_until(net, "a0", st, &u0);
    bool has_starttls = false;
    for (const auto& l : u0)
      if (l.find("STARTTLS") != std::string::npos) { has_starttls = true; break; }
    if (has_starttls) {
      net.send_all("a0 STARTTLS\r\n");
      imap_read_until(net, "a0", st, nullptr);
      if (st == "OK") {
        if (!net.starttls(cfg.host)) { err = "IMAP " + net.last_error(); return false; }
      }
    }
  }
  std::string status;
  net.send_all("a0 ID (\"name\" \"email-chatter\" \"version\" \"1.0\" \"vendor\" \"email-chatter\")\r\n");
  imap_read_until(net, "a0", status, nullptr);
  if (!net.send_all("a1 LOGIN " + imap_quote(cfg.user) + " " + imap_quote(cfg.pass) + "\r\n")) {
    err = "IMAP LOGIN 发送失败";
    return false;
  }
  if (!imap_read_until(net, "a1", status, nullptr) || status != "OK") { err = "IMAP 认证失败"; return false; }
  net.send_all("a2 LOGOUT\r\n");
  return true;
}

bool probe_greeting(const std::string& host, int port, bool ssl, int timeout_ms,
                    std::string& greeting, std::string& err) {
  greeting.clear();
  err.clear();
  if (host.empty() || port <= 0) { err = "主机或端口为空"; return false; }
  Net net;
  if (!net.connect(host, port, ssl, timeout_ms)) {
    err = "连接失败（端口不通 / 被防火墙拦截 / 主机名错误）";
    return false;
  }
  std::string line;
  if (!net.recv_line(line)) { err = "已连接但服务器无响应"; return false; }
  greeting = line;
  return true;
}

} // namespace proto