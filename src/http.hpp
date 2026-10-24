#pragma once
#include <cstdint>
#include <functional>
#include <map>
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
  std::map<std::string, std::string> headers;  // 附加响应头（Content-Disposition 等）

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
  // 二进制响应（附件下载）：显式指定 Content-Type 与原始字节。
  void set_bytes(int st, const std::string& ct, std::string data) {
    status = st;
    content_type = ct;
    body = std::move(data);
  }
  void set_header(const std::string& name, const std::string& value) { headers[name] = value; }
};

using Handler = std::function<void(const Request&, Response&)>;

// 按扩展名推断 Content-Type（静态资源与 /api/attachment 共用）。
std::string content_type_for(const std::string& path);

// Bind + listen. Returns the socket fd and the actual port (useful when port==0).
bool listen(const std::string& bind_host, int port, intptr_t& out_fd, int& out_port, std::string& err);
// Accept loop, blocks until shutdown() is called. Serves static files from web_dir;
// paths starting with /api/ are delegated to handler.
void run_loop(intptr_t listen_fd, const std::string& web_dir, const Handler& handler);
void shutdown(intptr_t listen_fd);

} // namespace http
