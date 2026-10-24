#include "ai.hpp"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <mutex>
#include <string>
#include <system_error>
#include <thread>
#include <vector>

#include "gguf.hpp"
#include "proto.hpp"

namespace ai {
namespace {

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

static std::string trim_str(const std::string& s) {
  size_t b = 0, e = s.size();
  while (b < e && (s[b] == ' ' || s[b] == '\t' || s[b] == '\r' || s[b] == '\n' || s[b] == '\f' ||
                   s[b] == '\v')) {
    ++b;
  }
  while (e > b && (s[e - 1] == ' ' || s[e - 1] == '\t' || s[e - 1] == '\r' ||
                   s[e - 1] == '\n' || s[e - 1] == '\f' || s[e - 1] == '\v')) {
    --e;
  }
  return s.substr(b, e - b);
}

static std::string to_lower_ascii(std::string s) {
  for (char& c : s) {
    if (c >= 'A' && c <= 'Z') c = (char)(c - 'A' + 'a');
  }
  return s;
}

static uint32_t utf8_cp(const std::string& s, size_t i, size_t& len) {
  const unsigned char c = (unsigned char)s[i];
  if (c < 0x80) {
    len = 1;
    return c;
  }
  int extra;
  uint32_t cp;
  if ((c & 0xE0) == 0xC0) {
    extra = 1;
    cp = c & 0x1F;
  } else if ((c & 0xF0) == 0xE0) {
    extra = 2;
    cp = c & 0x0F;
  } else if ((c & 0xF8) == 0xF0) {
    extra = 3;
    cp = c & 0x07;
  } else {
    len = 1;
    return 0xFFFD;
  }
  if (i + 1 + (size_t)extra > s.size()) {
    len = 1;
    return 0xFFFD;
  }
  for (int k = 1; k <= extra; ++k) {
    const unsigned char cc = (unsigned char)s[i + (size_t)k];
    if ((cc & 0xC0) != 0x80) {
      len = 1;
      return 0xFFFD;
    }
    cp = (cp << 6) | (cc & 0x3F);
  }
  len = (size_t)extra + 1;
  return cp;
}

static size_t utf8_cp_count(const std::string& s) {
  size_t n = 0, i = 0;
  while (i < s.size()) {
    size_t l;
    utf8_cp(s, i, l);
    i += l;
    ++n;
  }
  return n;
}

static std::string utf8_truncate(const std::string& s, size_t max_cp) {
  size_t i = 0, count = 0;
  while (i < s.size() && count < max_cp) {
    size_t l;
    utf8_cp(s, i, l);
    i += l;
    ++count;
  }
  return s.substr(0, i);
}

static void utf8_append(std::string& s, uint32_t cp) {
  if (cp < 0x80) {
    s.push_back((char)cp);
  } else if (cp < 0x800) {
    s.push_back((char)(0xC0 | (cp >> 6)));
    s.push_back((char)(0x80 | (cp & 0x3F)));
  } else if (cp < 0x10000) {
    s.push_back((char)(0xE0 | (cp >> 12)));
    s.push_back((char)(0x80 | ((cp >> 6) & 0x3F)));
    s.push_back((char)(0x80 | (cp & 0x3F)));
  } else {
    s.push_back((char)(0xF0 | (cp >> 18)));
    s.push_back((char)(0x80 | ((cp >> 12) & 0x3F)));
    s.push_back((char)(0x80 | ((cp >> 6) & 0x3F)));
    s.push_back((char)(0x80 | (cp & 0x3F)));
  }
}

static std::string collapse_spaces(const std::string& s) {
  std::string out;
  out.reserve(s.size());
  bool prev_space = true;
  for (size_t i = 0; i < s.size();) {
    size_t l;
    const uint32_t cp = utf8_cp(s, i, l);
    const bool is_space = (cp == ' ' || cp == '\t' || cp == '\r' || cp == '\n' || cp == '\f' ||
                           cp == '\v' || cp == 0x3000);
    if (is_space) {
      if (!prev_space) out.push_back(' ');
      prev_space = true;
    } else {
      out.append(s, i, l);
      prev_space = false;
    }
    i += l;
  }
  return trim_str(out);
}

static FILE* fopen_utf8(const std::string& path, const char* mode) {
#ifdef _WIN32
  std::wstring w = std::filesystem::u8path(path).wstring();
  std::wstring wm;
  for (const char* p = mode; *p; ++p) wm.push_back((wchar_t)(unsigned char)*p);
  return _wfopen(w.c_str(), wm.c_str());
#else
  return std::fopen(path.c_str(), mode);
#endif
}

static bool file_size_utf8(const std::string& path, long long& size) {
  FILE* f = fopen_utf8(path, "rb");
  if (!f) return false;
#ifdef _WIN32
  _fseeki64(f, 0, SEEK_END);
  size = (long long)_ftelli64(f);
#else
  std::fseek(f, 0, SEEK_END);
  size = (long long)std::ftell(f);
#endif
  std::fclose(f);
  return true;
}

static bool file_exists_utf8(const std::string& path) {
  std::error_code ec;
  return std::filesystem::exists(std::filesystem::u8path(path), ec);
}

static void remove_file_utf8(const std::string& path) {
  std::error_code ec;
  std::filesystem::remove(std::filesystem::u8path(path), ec);
}

static std::string base_name(const std::string& s) {
  const size_t p = s.find_last_of("/\\");
  return p == std::string::npos ? s : s.substr(p + 1);
}

static const char* kDefaultModelFile = "qwen2.5-0.5b-instruct-q4_k_m.gguf";

static std::string sanitize_model_file(const std::string& in) {
  std::string name = base_name(trim_str(in));
  // 原名去掉扩展名后为空（如 ".gguf" / "." / ".."）→ 回退默认名
  {
    const size_t d0 = name.rfind('.');
    const std::string stem0 = (d0 == std::string::npos) ? name : name.substr(0, d0);
    if (stem0.empty() || stem0 == "." || stem0 == "..") name = kDefaultModelFile;
  }
  // 清洗 Windows 非法文件名字符（保留 UTF-8 非 ASCII 字节），其余替换为 '_'
  std::string clean;
  clean.reserve(name.size());
  for (unsigned char c : name) {
    if (c < 0x80) {
      const bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
                      c == '.' || c == '_' || c == '-';
      clean.push_back(ok ? (char)c : '_');
    } else {
      clean.push_back((char)c);
    }
  }
  // 去掉首尾的点/下划线/空格（避免 ".", ".." 等）
  size_t b = 0, e = clean.size();
  while (b < e && (clean[b] == '.' || clean[b] == '_' || clean[b] == ' ')) ++b;
  while (e > b && (clean[e - 1] == '.' || clean[e - 1] == '_' || clean[e - 1] == ' ')) --e;
  clean = clean.substr(b, e - b);
  if (clean.size() > 120) {
    clean.resize(120);
    // 回退到 UTF-8 边界，避免切坏多字节字符
    while (!clean.empty() && ((unsigned char)clean.back() & 0xC0) == 0x80) clean.pop_back();
  }
  if (clean.empty()) clean = kDefaultModelFile;
  // 强制 .gguf 扩展名：后缀是短扩展名则替换，没有扩展名则追加
  std::string lower = to_lower_ascii(clean);
  if (lower.size() < 5 || lower.compare(lower.size() - 5, 5, ".gguf") != 0) {
    const size_t dot = clean.rfind('.');
    const bool has_short_ext =
        dot != std::string::npos && dot > 0 && clean.size() - dot - 1 >= 1 && clean.size() - dot - 1 <= 8;
    if (has_short_ext) {
      clean = clean.substr(0, dot) + ".gguf";
    } else {
      clean += ".gguf";
    }
  }
  return clean;
}

// 模型文件就绪校验：大小 ≥ 50MB（与下载校验一致）且首 4 字节为 GGUF magic。
// 仅看 magic 会把 4 字节假文件误判为"已就绪"。
static const long long kMinModelBytes = 50ll * 1024 * 1024;

static bool is_gguf_file(const std::string& path) {
  long long sz = 0;
  if (!file_size_utf8(path, sz) || sz < kMinModelBytes) return false;
  FILE* f = fopen_utf8(path, "rb");
  if (!f) return false;
  char magic[4] = {0};
  const size_t n = std::fread(magic, 1, 4, f);
  std::fclose(f);
  return n == 4 && std::memcmp(magic, "GGUF", 4) == 0;
}

// ---------------------------------------------------------------------------
// URL / HTTP 下载（走 proto::Net：TCP + 可选 OpenSSL TLS）
// ---------------------------------------------------------------------------

struct ParsedUrl {
  bool tls = true;
  std::string host;
  int port = 443;
  std::string path = "/";
};

static bool parse_url(const std::string& url, ParsedUrl& u, std::string& err) {
  std::string rest;
  if (url.compare(0, 8, "https://") == 0) {
    u.tls = true;
    u.port = 443;
    rest = url.substr(8);
  } else if (url.compare(0, 7, "http://") == 0) {
    u.tls = false;
    u.port = 80;
    rest = url.substr(7);
  } else {
    err = "不支持的 URL（仅支持 http/https）：" + url;
    return false;
  }
  const size_t slash = rest.find('/');
  std::string hostport = rest.substr(0, slash);
  u.path = (slash == std::string::npos) ? "/" : rest.substr(slash);
  const size_t at = hostport.find('@');
  if (at != std::string::npos) hostport = hostport.substr(at + 1);
  const size_t colon = hostport.rfind(':');
  if (colon != std::string::npos) {
    u.host = hostport.substr(0, colon);
    u.port = std::atoi(hostport.substr(colon + 1).c_str());
  } else {
    u.host = hostport;
  }
  if (u.host.empty() || u.port <= 0 || u.port > 65535) {
    err = "URL 主机/端口非法：" + url;
    return false;
  }
  return true;
}

static std::string url_origin(const ParsedUrl& u) {
  std::string s = u.tls ? "https://" : "http://";
  s += u.host;
  if ((u.tls && u.port != 443) || (!u.tls && u.port != 80)) s += ":" + std::to_string(u.port);
  return s;
}

static std::string resolve_redirect(const std::string& base, const std::string& loc) {
  const std::string l = trim_str(loc);
  if (l.compare(0, 7, "http://") == 0 || l.compare(0, 8, "https://") == 0) return l;
  ParsedUrl b;
  std::string e;
  if (!parse_url(base, b, e)) return l;
  if (!l.empty() && l[0] == '/') return url_origin(b) + l;
  const size_t slash = b.path.rfind('/');
  const std::string dir = (slash == std::string::npos) ? "/" : b.path.substr(0, slash + 1);
  return url_origin(b) + dir + l;
}

enum class DlResult { Ok, Cancelled, Error };

struct DlContext {
  std::atomic<bool>* cancel = nullptr;
  std::atomic<long long>* got = nullptr;
  std::atomic<long long>* total = nullptr;
};

// 下载一个 URL 到 part_path（处理 301/302/303/307/308，≤5 次）。
static DlResult http_download(const std::string& url, const std::string& part_path, DlContext& ctx,
                              std::string& err) {
  std::string current = url;
  for (int redirect = 0; redirect <= 5; ++redirect) {
    ParsedUrl u;
    if (!parse_url(current, u, err)) return DlResult::Error;
    if (u.tls && !proto::Net::has_tls()) {
      err = "当前构建未启用 TLS（缺少 OpenSSL），无法下载 https 模型；请安装 OpenSSL 后重新编译";
      return DlResult::Error;
    }
    proto::Net net;
    if (!net.connect(u.host, u.port, u.tls, 15000)) {
      err = "无法连接 " + u.host + ":" + std::to_string(u.port) + "（" + net.last_error() + "）";
      return DlResult::Error;
    }
    std::string host_hdr = u.host;
    if ((u.tls && u.port != 443) || (!u.tls && u.port != 80)) {
      host_hdr += ":" + std::to_string(u.port);
    }
    const std::string req = "GET " + u.path +
                            " HTTP/1.1\r\nHost: " + host_hdr +
                            "\r\nUser-Agent: EmailChatter/2.0\r\nAccept: */*\r\nConnection: close\r\n\r\n";
    if (!net.send_all(req)) {
      err = "发送 HTTP 请求失败";
      return DlResult::Error;
    }
    std::string line;
    if (!net.recv_line(line)) {
      err = "读取 HTTP 响应失败（服务器无响应）";
      return DlResult::Error;
    }
    int status = 0;
    if (line.size() >= 12 && line.compare(0, 5, "HTTP/") == 0) status = std::atoi(line.c_str() + 9);
    if (status == 0) {
      err = "HTTP 响应格式异常：" + line.substr(0, 120);
      return DlResult::Error;
    }
    long long content_length = -1;
    bool chunked = false;
    std::string location;
    for (;;) {
      if (!net.recv_line(line)) {
        err = "读取 HTTP 响应头失败";
        return DlResult::Error;
      }
      if (line.empty()) break;
      const size_t cp = line.find(':');
      if (cp == std::string::npos) continue;
      const std::string name = to_lower_ascii(trim_str(line.substr(0, cp)));
      const std::string value = trim_str(line.substr(cp + 1));
      if (name == "content-length") {
        content_length = std::atoll(value.c_str());
      } else if (name == "transfer-encoding" && to_lower_ascii(value).find("chunked") != std::string::npos) {
        chunked = true;
      } else if (name == "location") {
        location = value;
      }
    }
    if (status == 301 || status == 302 || status == 303 || status == 307 || status == 308) {
      if (location.empty()) {
        err = "服务器返回重定向但缺少 Location 头";
        return DlResult::Error;
      }
      current = resolve_redirect(current, location);
      continue;
    }
    if (status != 200) {
      err = "服务器返回 HTTP " + std::to_string(status);
      return DlResult::Error;
    }
    if (ctx.cancel->load()) return DlResult::Cancelled;

    FILE* f = fopen_utf8(part_path, "wb");
    if (!f) {
      err = "无法写入临时文件：" + part_path;
      return DlResult::Error;
    }
    auto abort_err = [&](const std::string& e) {
      std::fclose(f);
      err = e;
      return DlResult::Error;
    };
    if (!chunked && content_length >= 0) ctx.total->store(content_length);
    long long written = 0;
    if (chunked) {
      for (;;) {
        if (!net.recv_line(line)) return abort_err("读取 chunk 头失败（下载中断）");
        if (ctx.cancel->load()) {
          std::fclose(f);
          return DlResult::Cancelled;
        }
        const long long chunk = std::strtoll(line.c_str(), nullptr, 16);
        if (chunk < 0 || chunk > (long long)64 * 1024 * 1024) {
          return abort_err("chunk 长度非法：" + line.substr(0, 80));
        }
        if (chunk == 0) {
          // 读掉 trailer（可能没有）
          while (net.recv_line(line) && !line.empty()) {
          }
          break;
        }
        std::string data;
        if (!net.recv_exact(data, (size_t)chunk)) return abort_err("下载中断（chunk 数据不完整）");
        if (std::fwrite(data.data(), 1, data.size(), f) != data.size()) {
          return abort_err("写入临时文件失败（磁盘空间不足？）");
        }
        written += chunk;
        ctx.got->store(written);
        std::string crlf;
        if (!net.recv_exact(crlf, 2)) return abort_err("下载中断（chunk 结尾缺失）");
      }
      ctx.total->store(written);
    } else if (content_length >= 0) {
      long long remaining = content_length;
      std::string data;
      while (remaining > 0) {
        if (ctx.cancel->load()) {
          std::fclose(f);
          return DlResult::Cancelled;
        }
        const size_t take = (size_t)std::min<long long>(remaining, 64 * 1024);
        data.clear();
        if (!net.recv_exact(data, take)) return abort_err("下载中断（连接提前关闭）");
        if (std::fwrite(data.data(), 1, data.size(), f) != data.size()) {
          return abort_err("写入临时文件失败（磁盘空间不足？）");
        }
        remaining -= (long long)take;
        written += (long long)take;
        ctx.got->store(written);
      }
      ctx.total->store(content_length);
    } else {
      std::fclose(f);
      err = "服务器未提供 Content-Length 或 chunked 编码，无法确定下载大小";
      return DlResult::Error;
    }
    if (std::fflush(f) != 0) return abort_err("刷新临时文件失败");
    std::fclose(f);
    return DlResult::Ok;
  }
  err = "重定向次数过多（>5）";
  return DlResult::Error;
}

static bool validate_downloaded(const std::string& part_path, std::string& err) {
  long long sz = 0;
  if (!file_size_utf8(part_path, sz) || sz <= 0) {
    err = "下载文件为空";
    return false;
  }
  FILE* f = fopen_utf8(part_path, "rb");
  if (!f) {
    err = "无法打开下载的临时文件";
    return false;
  }
  char magic[4] = {0};
  const size_t n = std::fread(magic, 1, 4, f);
  std::fclose(f);
  if (n != 4 || std::memcmp(magic, "GGUF", 4) != 0) {
    err = "下载内容不是有效的 GGUF 模型（首 4 字节不是 GGUF，可能是错误页面）";
    return false;
  }
  const long long kMin = 50ll * 1024 * 1024;
  if (sz < kMin) {
    char buf[160];
    std::snprintf(buf, sizeof buf, "模型文件过小（%.1f MB，预期 ≥ 50 MB）", (double)sz / 1048576.0);
    err = buf;
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Manager 全局状态
// ---------------------------------------------------------------------------

struct ManagerState {
  mutable std::mutex mu;    // 保护 cfg/paths/model_ready/error
  std::mutex inf_mu;        // 串行化 生成/加载/卸载
  std::mutex dl_mu;         // 串行化 start/cancel download

  Config cfg;
  std::string data_dir;
  std::string models_dir;
  std::string model_path;
  std::string part_path;
  bool initialized = false;
  bool model_ready = false;
  std::string error;

  std::atomic<bool> downloading{false};
  std::atomic<bool> cancel{false};
  std::atomic<bool> busy{false};
  std::atomic<long long> got{0};
  std::atomic<long long> total{0};
  std::thread dl_thread;

  // 仅 inf_mu 保护
  std::unique_ptr<gguf::Qwen2Engine> engine;
  std::string engine_path;
  std::chrono::steady_clock::time_point last_use;

  ~ManagerState() {
    if (dl_thread.joinable()) dl_thread.join();
  }
};

static ManagerState& state() {
  static ManagerState s;
  return s;
}

static std::vector<std::string> build_urls(const std::string& mirror_in,
                                           const std::string& model_url) {
  const std::string mu = trim_str(model_url);
  if (!mu.empty()) return {mu};
  std::string mirror = trim_str(mirror_in);
  if (mirror.empty()) mirror = "https://hf-mirror.com";
  while (!mirror.empty() && mirror.back() == '/') mirror.pop_back();
  return {
      mirror + "/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf?download=true",
      mirror + "/bartowski/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/Qwen2.5-0.5B-Instruct-Q4_K_M.gguf?download=true",
      mirror + "/unsloth/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/Qwen2.5-0.5B-Instruct-Q4_K_M.gguf?download=true",
  };
}

static void run_download(ManagerState& s, std::vector<std::string> urls, std::string part_path,
                         std::string model_path) {
  std::string last_err;
  DlResult result = DlResult::Error;
  DlContext ctx;
  ctx.cancel = &s.cancel;
  ctx.got = &s.got;
  ctx.total = &s.total;

  for (const std::string& url : urls) {
    if (s.cancel.load()) {
      result = DlResult::Cancelled;
      break;
    }
    s.got.store(0);
    s.total.store(0);
    remove_file_utf8(part_path);
    std::string err;
    result = http_download(url, part_path, ctx, err);
    if (result == DlResult::Cancelled) break;
    if (result == DlResult::Error) {
      last_err = err;
      remove_file_utf8(part_path);
      continue;
    }
    if (!validate_downloaded(part_path, err)) {
      last_err = err;
      remove_file_utf8(part_path);
      result = DlResult::Error;
      continue;
    }
    std::error_code ec;
    std::filesystem::rename(std::filesystem::u8path(part_path), std::filesystem::u8path(model_path),
                            ec);
    if (ec) {
      last_err = "重命名 .part 为模型文件失败：" + ec.message();
      remove_file_utf8(part_path);
      result = DlResult::Error;
      continue;
    }
    {
      std::lock_guard<std::mutex> lk(s.mu);
      s.model_ready = true;
      s.error.clear();
    }
    s.downloading.store(false);
    return;
  }
  remove_file_utf8(part_path);
  {
    std::lock_guard<std::mutex> lk(s.mu);
    s.model_ready = is_gguf_file(model_path);
    if (result == DlResult::Cancelled) {
      s.error = "下载已取消";
    } else {
      s.error = "模型下载失败：" + (last_err.empty() ? std::string("未知错误") : last_err);
    }
  }
  s.got.store(0);
  s.total.store(0);
  s.downloading.store(false);
}

static bool ensure_engine(ManagerState& s, const std::string& model_path, std::string& note) {
  if (s.engine && s.engine_path == model_path) return true;
  s.engine.reset();
  s.engine_path.clear();
  auto e = std::make_unique<gguf::Qwen2Engine>();
  std::string err;
  if (!e->load(model_path, err)) {
    note = "模型加载失败：" + err;
    std::lock_guard<std::mutex> lk(s.mu);
    s.error = note;
    return false;
  }
  s.engine = std::move(e);
  s.engine_path = model_path;
  s.last_use = std::chrono::steady_clock::now();
  {
    std::lock_guard<std::mutex> lk(s.mu);
    s.error.clear();
  }
  return true;
}

static std::string strip_markdown(const std::string& line) {
  std::string s = line;
  // 1) 去掉行首的 markdown 标记（# > * ` - + ~ _）
  size_t i = 0;
  while (i < s.size()) {
    const char c = s[i];
    if (c == '#' || c == '>' || c == '*' || c == '`' || c == '-' || c == '+' || c == '~' ||
        c == '_') {
      ++i;
      continue;
    }
    break;
  }
  // 2) 去掉有序列表标记 "1." / "1)"
  if (i < s.size() && s[i] >= '0' && s[i] <= '9') {
    size_t k = i;
    while (k < s.size() && s[k] >= '0' && s[k] <= '9') ++k;
    if (k < s.size() && (s[k] == '.' || s[k] == ')')) i = k + 1;
  }
  s = s.substr(i);
  // 3) 去掉强调/代码标记（**、__、~~、反引号）与首尾残留的单个 * _ ~
  auto erase_all = [&](const char* pat) {
    const size_t n = std::strlen(pat);
    for (size_t p = s.find(pat); p != std::string::npos; p = s.find(pat, p)) s.erase(p, n);
  };
  erase_all("**");
  erase_all("__");
  erase_all("~~");
  erase_all("`");
  while (!s.empty() && (s.front() == '*' || s.front() == '_' || s.front() == '~')) s.erase(s.begin());
  while (!s.empty() && (s.back() == '*' || s.back() == '_' || s.back() == '~')) s.pop_back();
  return collapse_spaces(s);
}

}  // namespace

// ---------------------------------------------------------------------------
// 纯函数：启发式标题 / 提示词 / 后处理
// ---------------------------------------------------------------------------

std::string heuristic_title(const std::string& text) {
  size_t start = 0;
  for (;;) {
    const size_t end = text.find('\n', start);
    std::string line =
        (end == std::string::npos) ? text.substr(start) : text.substr(start, end - start);
    if (!line.empty() && line.back() == '\r') line.pop_back();
    std::string s = strip_markdown(line);
    if (!s.empty()) {
      if (utf8_cp_count(s) > 30) s = utf8_truncate(s, 30) + "…";
      return s;
    }
    if (end == std::string::npos) break;
    start = end + 1;
  }
  return "无主题";
}

std::string build_prompt(const std::string& text) {
  static const char* kSystem =
      "你是一个邮件主题生成助手。根据用户消息生成一个简洁、准确、不夸张的中文邮件主题，不超过20个字；"
      "只输出主题本身，不要引号、不要\"标题：\"前缀、不要解释、不要句号。";
  std::string s;
  s.reserve(256);
  s += "<|im_start|>system\n";
  s += kSystem;
  s += "<|im_end|>\n<|im_start|>user\n";
  s += utf8_truncate(text, 600);
  s += "<|im_end|>\n<|im_start|>assistant\n";
  return s;
}

std::string postprocess_title(const std::string& raw) {
  std::string s = trim_str(raw);
  // 去 "标题:" / "标题：" 前缀（允许重复出现几次）
  for (int guard = 0; guard < 3; ++guard) {
    if (s.compare(0, 7, "标题:") == 0) {
      s = trim_str(s.substr(7));
    } else if (s.compare(0, 9, "标题：") == 0) {
      s = trim_str(s.substr(9));
    } else {
      break;
    }
  }
  // 去包裹引号
  struct Pair {
    const char* open;
    const char* close;
  };
  static const Pair kPairs[] = {
      {"\"", "\""}, {"“", "”"}, {"'", "'"}, {"‘", "’"}, {"「", "」"}, {"『", "』"},
  };
  for (const auto& p : kPairs) {
    const size_t ol = std::strlen(p.open);
    const size_t cl = std::strlen(p.close);
    if (s.size() >= ol + cl && s.compare(0, ol, p.open) == 0 &&
        s.compare(s.size() - cl, cl, p.close) == 0) {
      s = trim_str(s.substr(ol, s.size() - ol - cl));
      break;
    }
  }
  // 去尾部标点（按 UTF-8 码点，中文标点占 3 字节）
  for (;;) {
    if (s.empty()) break;
    size_t last = s.size();
    while (last > 0 && ((unsigned char)s[last - 1] & 0xC0) == 0x80) --last;
    size_t l = 0;
    const uint32_t cp = utf8_cp(s, last, l);
    const bool punct = (cp == '.' || cp == '!' || cp == '?' || cp == 0x3002 || cp == 0xFF0E ||
                        cp == 0xFF01 || cp == 0xFF1F);
    if (!punct) break;
    s.resize(last);
    s = trim_str(s);
  }
  // 换行合并为空格 + 压缩空白
  s = collapse_spaces(s);
  // 截断 40 字符
  if (utf8_cp_count(s) > 40) s = utf8_truncate(s, 40);
  return trim_str(s);
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

Manager::Manager() = default;
Manager::~Manager() = default;

void Manager::init(const std::string& data_dir) {
  ManagerState& s = state();
  std::lock_guard<std::mutex> lk(s.mu);
  std::string dd = data_dir;
  while (!dd.empty() && (dd.back() == '/' || dd.back() == '\\')) dd.pop_back();
  s.data_dir = dd;
  s.models_dir = dd.empty() ? std::string("data/models") : dd + "/models";
  std::error_code ec;
  std::filesystem::create_directories(std::filesystem::u8path(s.models_dir), ec);
  s.initialized = true;
  const std::string fname = sanitize_model_file(s.cfg.model_file);
  s.model_path = s.models_dir + "/" + fname;
  s.part_path = s.model_path + ".part";
  s.model_ready = is_gguf_file(s.model_path);
  if (s.model_ready) s.error.clear();
}

void Manager::set_config(const Config& c) {
  ManagerState& s = state();
  std::lock_guard<std::mutex> lk(s.mu);
  s.cfg = c;
  if (!s.initialized) return;
  const std::string fname = sanitize_model_file(c.model_file);
  const std::string new_path = s.models_dir + "/" + fname;
  if (new_path != s.model_path) {
    s.model_path = new_path;
    s.part_path = new_path + ".part";
    s.model_ready = is_gguf_file(new_path);
  }
}

Config Manager::config() const {
  ManagerState& s = state();
  std::lock_guard<std::mutex> lk(s.mu);
  return s.cfg;
}

Status Manager::status() const {
  ManagerState& s = state();
  Status out;
  {
    std::lock_guard<std::mutex> lk(s.mu);
    out.enabled = s.cfg.enabled;
    out.model_ready = s.model_ready;
    out.downloading = s.downloading.load();
    out.busy = s.busy.load();
    out.downloaded_bytes = s.got.load();
    out.total_bytes = s.total.load();
    out.error = s.error;
    out.mirror = s.cfg.mirror.empty() ? std::string("https://hf-mirror.com") : s.cfg.mirror;
    out.model_file = sanitize_model_file(s.cfg.model_file);
    std::string eng = out.model_file;
    if (eng.size() > 5 && eng.compare(eng.size() - 5, 5, ".gguf") == 0) eng.resize(eng.size() - 5);
    out.engine = eng;
  }
  return out;
}

bool Manager::start_download(std::string& err) {
  ManagerState& s = state();
  std::lock_guard<std::mutex> dlk(s.dl_mu);
  if (s.downloading.load()) {
    err = "下载已在进行中";
    return false;
  }
  std::string model_path, part_path;
  Config cfg;
  bool ready = false;
  {
    std::lock_guard<std::mutex> lk(s.mu);
    if (!s.initialized) {
      err = "AI 引擎未初始化";
      return false;
    }
    ready = s.model_ready;
    model_path = s.model_path;
    part_path = s.part_path;
    cfg = s.cfg;
  }
  if (ready) {
    err = "模型已就绪，无需下载";
    return false;
  }
  if (s.dl_thread.joinable()) s.dl_thread.join();
  {
    std::lock_guard<std::mutex> lk(s.mu);
    s.error.clear();
    s.got.store(0);
    s.total.store(0);
    s.cancel.store(false);
    s.downloading.store(true);
  }
  const std::vector<std::string> urls = build_urls(cfg.mirror, cfg.model_url);
  s.dl_thread = std::thread([&s, urls, part_path, model_path] {
    run_download(s, urls, part_path, model_path);
  });
  return true;
}

void Manager::cancel_download() {
  ManagerState& s = state();
  {
    std::lock_guard<std::mutex> dlk(s.dl_mu);
    if (!s.downloading.load()) return;
    s.cancel.store(true);
  }
  // 等后台线程收尾（最多 5s），保证 .part 已删除、downloading=false
  for (int i = 0; i < 100; ++i) {
    if (!s.downloading.load()) break;
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
  }
  std::lock_guard<std::mutex> dlk(s.dl_mu);
  if (!s.downloading.load() && s.dl_thread.joinable()) s.dl_thread.join();
}

std::string Manager::generate_title(const std::string& text, std::string& source,
                                    std::string& note) {
  source = "heuristic";
  note.clear();
  const std::string fallback = heuristic_title(text);
  ManagerState& s = state();
  Config cfg;
  bool ready = false;
  bool downloading = false;
  {
    std::lock_guard<std::mutex> lk(s.mu);
    cfg = s.cfg;
    ready = s.model_ready;
    downloading = s.downloading.load();
  }
  if (!cfg.enabled) {
    note = "未启用 AI 标题";
    return fallback;
  }
  if (downloading) {
    note = "模型正在下载中";
    return fallback;
  }
  if (!ready) {
    note = "模型未下载";
    return fallback;
  }
  std::unique_lock<std::mutex> inf(s.inf_mu);
  s.busy.store(true);
  struct BusyGuard {
    std::atomic<bool>* b;
    ~BusyGuard() { b->store(false); }
  } guard{&s.busy};

  std::string model_path;
  {
    std::lock_guard<std::mutex> lk(s.mu);
    model_path = s.model_path;
  }
  std::string err;
  if (!ensure_engine(s, model_path, err)) {
    note = err;
    return fallback;
  }
  std::vector<int> ids;
  try {
    ids = s.engine->tokenizer().encode(build_prompt(text), true);
  } catch (...) {
    note = "提示词编码异常";
    return fallback;
  }
  if (ids.empty()) {
    note = "提示词编码失败";
    return fallback;
  }
  std::vector<int> out;
  if (!s.engine->generate(ids, 24, true, out, err)) {
    note = "推理失败：" + err;
    return fallback;
  }
  const std::string raw = s.engine->tokenizer().decode(out);
  const std::string title = postprocess_title(raw);
  if (title.empty()) {
    note = "模型输出为空";
    return fallback;
  }
  s.last_use = std::chrono::steady_clock::now();
  source = "ai";
  return title;
}

void Manager::idle_tick() {
  ManagerState& s = state();
  std::unique_lock<std::mutex> inf(s.inf_mu, std::try_to_lock);
  if (!inf.owns_lock()) return;
  if (!s.engine) return;
  if (s.busy.load()) return;
  int idle_sec = 300;
  if (const char* e = std::getenv("AI_IDLE_SECONDS")) {
    const int v = std::atoi(e);
    if (v > 0) idle_sec = v;
  }
  const auto now = std::chrono::steady_clock::now();
  if (now - s.last_use >= std::chrono::seconds(idle_sec)) {
    s.engine.reset();
    s.engine_path.clear();
  }
}

Manager& manager() {
  static Manager m;
  return m;
}

}  // namespace ai
