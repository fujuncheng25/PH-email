#include <atomic>
#include <cctype>
#include <chrono>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <string>
#include <thread>
#include <vector>

#include "app.hpp"
#include "proto.hpp"
#include "util.hpp"

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#else
#include <unistd.h>
#endif

#ifdef __APPLE__
#include <mach-o/dyld.h>
#endif

namespace {

std::atomic<bool> g_stop{false};

void on_signal(int) { g_stop = true; }

bool file_exists(const std::string& path) {
  FILE* f = std::fopen(path.c_str(), "rb");
  if (!f) return false;
  std::fclose(f);
  return true;
}

std::string dir_of(const std::string& p) {
  auto pos = p.find_last_of("\\/");
  return pos == std::string::npos ? "." : p.substr(0, pos);
}

std::string exe_dir(const char* argv0) {
#ifdef _WIN32
  char buf[MAX_PATH + 1];
  DWORD n = GetModuleFileNameA(nullptr, buf, MAX_PATH);
  if (n > 0) return dir_of(std::string(buf, n));
  return argv0 ? dir_of(argv0) : ".";
#elif defined(__APPLE__)
  char buf[4096];
  uint32_t size = sizeof buf;
  if (_NSGetExecutablePath(buf, &size) == 0) return dir_of(buf);
  return ".";
#else
  char buf[4096];
  ssize_t n = readlink("/proc/self/exe", buf, sizeof buf - 1);
  if (n > 0) {
    buf[n] = 0;
    return dir_of(buf);
  }
  n = readlink("/proc/curproc/file", buf, sizeof buf - 1); // FreeBSD
  if (n > 0) {
    buf[n] = 0;
    return dir_of(buf);
  }
  return argv0 ? dir_of(argv0) : ".";
#endif
}

std::string canon_path(const std::string& p) {
  std::error_code ec;
  auto c = std::filesystem::weakly_canonical(std::filesystem::path(p), ec);
  return ec ? p : c.string();
}

// 严格包含判断：child 必须位于 parent 之内（或等于它）。
// 数据目录 / 网页目录都在程序目录内，程序目录之外 0 读取、0 写入。
bool path_inside(const std::string& child, const std::string& parent) {
  std::string c = canon_path(child);
  std::string p = canon_path(parent);
#ifdef _WIN32
  for (auto& ch : c) ch = (char)std::tolower((unsigned char)ch);
  for (auto& ch : p) ch = (char)std::tolower((unsigned char)ch);
#endif
  if (c == p) return true;
  if (c.size() <= p.size() + 1) return false;
  if (c.compare(0, p.size(), p) != 0) return false;
  const char sep = c[p.size()];
  return sep == '/' || sep == '\\';
}

// 网页资源只允许放在 <程序目录>/web（或 --web 指定的程序目录内子目录）
std::string resolve_web_dir(const std::string& arg, const std::string& edir) {
  return arg.empty() ? (edir + "/web") : canon_path(arg);
}

void open_browser(const std::string& url) {
#ifdef _WIN32
  std::string cmd = "start \"\" \"" + url + "\"";
  system(cmd.c_str());
#elif defined(__APPLE__)
  std::string cmd = "open \"" + url + "\" >/dev/null 2>&1 &";
  system(cmd.c_str());
#else
  std::string cmd = "xdg-open \"" + url + "\" >/dev/null 2>&1 &";
  system(cmd.c_str());
#endif
}

struct Args {
  int port = 48731;
  std::string data;
  std::string web;
  std::string host = "127.0.0.1";
  bool no_browser = false;
  bool tls_info = false;  // --tls-info：打印 TLS 根证书诊断后退出
};

void print_usage(const char* prog) {
  std::printf(
      "用法: %s [选项]\n"
      "  --port N         HTTP 界面监听端口（默认 48731，0 表示自动选择）\n"
      "  --host ADDR      监听地址（默认 127.0.0.1；对外网开放用 0.0.0.0）\n"
      "  --data DIR       数据目录（默认: 程序目录/data，必须在程序目录内）\n"
      "  --web DIR        网页资源目录（默认: 程序目录/web，必须在程序目录内）\n"
      "  --tls-info       打印 TLS 根证书诊断信息后退出（排查“问候失败”）\n"
      "  --no-browser     启动后不自动打开浏览器\n"
      "  -h, --help       显示此帮助\n",
      prog);
}

bool parse_args(int argc, char** argv, Args& args) {
  for (int i = 1; i < argc; ++i) {
    std::string a = argv[i];
    auto need = [&](std::string& out) -> bool {
      if (i + 1 >= argc) return false;
      out = argv[++i];
      return true;
    };
    if (a == "-h" || a == "--help") {
      print_usage(argv[0]);
      std::exit(0);
    } else if (a == "--port") {
      std::string v;
      if (!need(v)) return false;
      args.port = std::atoi(v.c_str());
    } else if (a == "--host") {
      if (!need(args.host)) return false;
    } else if (a == "--data") {
      if (!need(args.data)) return false;
    } else if (a == "--web") {
      if (!need(args.web)) return false;
    } else if (a == "--no-browser") {
      args.no_browser = true;
    } else if (a == "--tls-info") {
      args.tls_info = true;
    } else {
      std::fprintf(stderr, "未知参数: %s\n", a.c_str());
      return false;
    }
  }
  return true;
}

} // namespace

int main(int argc, char** argv) {
  Args args;
  if (!parse_args(argc, argv, args)) {
    print_usage(argv[0]);
    return 1;
  }
  // --tls-info：只打印 TLS 根证书诊断（不启动服务、不读写 data），用于排查“问候失败”。
  if (args.tls_info) {
#ifdef _WIN32
    SetConsoleOutputCP(CP_UTF8);
#endif
    std::string info;
    const bool ok = proto::tls_info(info);
    std::printf("Email Chatter TLS 诊断\n");
    std::printf("%s", info.c_str());
    std::printf("程序目录: %s\n", exe_dir(argc > 0 ? argv[0] : "").c_str());
    std::fflush(stdout);
    return ok ? 0 : 1;
  }
  const std::string edir = exe_dir(argc > 0 ? argv[0] : "");
  const std::string prog = canon_path(edir);
  const std::string web = resolve_web_dir(args.web, edir);

  // 安全边界：网页资源与数据都必须位于程序目录内（程序目录外 0 读取 / 0 写入）
  if (!path_inside(web, prog)) {
    std::fprintf(stderr, "拒绝启动：--web 指定的网页资源目录必须在程序目录内\n  程序目录: %s\n  指定目录: %s\n",
                 prog.c_str(), args.web.c_str());
    return 1;
  }
  if (!file_exists(web + "/index.html")) {
    std::fprintf(stderr, "启动失败：找不到界面资源 %s/index.html\n"
                         "请确认 web 文件夹与程序放在同一目录（不要单独拷走 exe）。\n",
                 web.c_str());
    return 1;
  }

  std::string data;
  if (args.data.empty()) {
    data = edir + "/data";
  } else {
    data = canon_path(args.data);
    if (!path_inside(data, prog)) {
      std::fprintf(stderr, "拒绝启动：--data 指定的数据目录必须在程序目录内\n"
                           "  程序目录: %s\n  指定目录: %s\n",
                   prog.c_str(), args.data.c_str());
      return 1;
    }
  }

  std::signal(SIGINT, on_signal);
  std::signal(SIGTERM, on_signal);

  app::App application;
  std::string err;
  if (!application.init(data, web, args.host, args.port, err)) {
    std::fprintf(stderr, "启动失败: %s\n", err.c_str());
    return 1;
  }
  application.start_threads();

  std::string host_for_url = args.host;
  if (host_for_url.empty() || host_for_url == "0.0.0.0" || host_for_url == "::") host_for_url = "127.0.0.1";
  const std::string url = "http://" + host_for_url + ":" + std::to_string(application.bound_port()) + "/";

  std::printf("email-chatter - 基于邮件 (SMTP/POP3/IMAP) 的即时聊天客户端\n");
  std::printf("数据目录: %s\n", data.c_str());
  std::printf("界面目录: %s\n", web.c_str());
  std::printf("界面地址: %s\n", url.c_str());
  std::printf("按 Ctrl+C 退出。\n");
  std::fflush(stdout);

  if (!args.no_browser) open_browser(url);

  while (!g_stop) std::this_thread::sleep_for(std::chrono::milliseconds(200));
  application.stop();
  std::printf("已退出。\n");
  return 0;
}