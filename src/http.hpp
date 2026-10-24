#pragma once
#include <cstdint>
#include <functional>
#include <string>

namespace http {

struct Request {
  std::string method;
  std::string path;
  std::string body;
  std::string host;   // 请求 Host 头（用于 CSRF / DNS-rebinding 防护）
  std::string origin; // 请求 Origin 头（浏览器同源策略信息，可为空）
};

struct Response {
  int status = 200;
  std::string content_type = "application/json; charset=utf-8";
  std::string body;

  void set_json(int st, const std::string& j) {
    status = st;
    content_type = "application/json; charset=utf-8";
    body = j;
  }
  void set_text(int st, const std::string& t) {
    status = st;
    content_type = "text/plain; charset=utf-8";
    body = t;
  }
};

using Handler = std::function<void(const Request&, Response&)>;

// Bind + listen. Returns the socket fd and the actual port (useful when port==0).
bool listen(const std::string& bind_host, int port, intptr_t& out_fd, int& out_port, std::string& err);
// Accept loop, blocks until shutdown() is called. Serves static files from web_dir;
// paths starting with /api/ are delegated to handler.
void run_loop(intptr_t listen_fd, const std::string& web_dir, const Handler& handler);
void shutdown(intptr_t listen_fd);

} // namespace http