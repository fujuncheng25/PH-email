#include "proto.hpp"

#include <algorithm>
#include <cctype>
#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <sstream>
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

#ifdef _WIN32
// Windows 系统根证书库（crypt32）：OpenSSL 默认 OPENSSLDIR 在 Windows 上通常不存在，
// 必须显式枚举系统证书库，否则 X509_VERIFY_PARAM 0 根证书 → 所有 TLS 握手证书校验失败。
#include <windows.h>
#include <wincrypt.h>
#elif defined(__APPLE__)
#include <mach-o/dyld.h>
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

namespace {
// 把“TLS 握手失败 → 回退明文”的原因附加到最终错误信息里，
// 避免真实原因被裸“问候失败”掩盖（Windows 根证书缺失的典型症状）。
std::string tls_fallback_note(const std::string& tls_err) {
  if (tls_err.empty()) return "";
  return "（原 TLS 失败原因：" + tls_err +
         "；已回退明文重试——请检查端口/SSL 配置或本机根证书，可用 --tls-info 查看）";
}

// 判断某个连接错误是否属于 TLS 握手失败（需要回退明文的情况）
bool is_tls_handshake_error(const std::string& e) {
  return e.find("TLS 握手失败") != std::string::npos ||
         e.find("STARTTLS 握手失败") != std::string::npos;
}

// 建立邮件协议连接：优先按配置做 TLS；TLS 握手失败（证书/根证书问题或端口不是 SSL）
// 时自动回退明文重连，并把原始 TLS 失败原因返回给调用方（用于后续错误信息）。
// 返回 false 时 err 为底层连接错误（不含“无法连接 X 服务器”前缀）。
bool connect_mail(Net& net, const std::string& host, int port, bool ssl, int timeout_ms,
                  bool& used_tls, std::string& tls_reason, std::string& err) {
  used_tls = ssl;
  tls_reason.clear();
  if (net.connect(host, port, ssl, timeout_ms)) return true;
  if (ssl && is_tls_handshake_error(net.last_error())) {
    tls_reason = net.last_error();
    used_tls = false;
    if (net.connect(host, port, false, timeout_ms)) return true;
    err = net.last_error();
    return false;
  }
  err = net.last_error();
  return false;
}
} // namespace

bool Net::has_tls() {
#ifdef HAS_OPENSSL
  return true;
#else
  return false;
#endif
}

#ifdef HAS_OPENSSL
namespace {

// TLS 信任链加载统计（供 --tls-info 诊断；“问候失败”根因排查用）
struct TlsTrustInfo {
  int default_paths = 0;  // OpenSSL 默认信任路径（含 SSL_CERT_FILE/SSL_CERT_DIR）新增证书数
#ifdef _WIN32
  int win_current_user_root = 0;
  int win_current_user_ca = 0;
  int win_local_machine_root = 0;
  int win_local_machine_ca = 0;
#endif
  std::vector<std::pair<std::string, int>> local_files;  // 本地 CA 文件与新增证书数
  std::string search_dir;  // 本地 CA 搜索目录（程序目录）
  bool initialized = false;
};

TlsTrustInfo g_trust;
std::mutex g_trust_mu;
SSL_CTX* g_tls_ctx = nullptr;

// 可执行文件所在目录（用于查找程序目录内的 cacert.pem 等本地 CA）
std::string platform_exe_dir() {
  std::string path;
#ifdef _WIN32
  char buf[MAX_PATH + 1];
  DWORD n = GetModuleFileNameA(nullptr, buf, MAX_PATH);
  if (n == 0 || n >= MAX_PATH) return ".";
  path.assign(buf, n);
#elif defined(__APPLE__)
  char buf[4096];
  uint32_t size = sizeof buf;
  if (_NSGetExecutablePath(buf, &size) != 0) return ".";
  path = buf;
#else
  char buf[4096];
  ssize_t n = readlink("/proc/self/exe", buf, sizeof buf - 1);
  if (n <= 0) return ".";
  buf[n] = 0;
  path = buf;
#endif
  auto pos = path.find_last_of("\\/");
  if (pos == std::string::npos) return ".";
  return path.substr(0, pos);
}

// 统计 X509_STORE 中已加载的证书数（用于诊断与“是否加载成功”计数）
int count_store_certs(X509_STORE* store) {
  if (!store) return 0;
#if OPENSSL_VERSION_NUMBER >= 0x10100000L
  STACK_OF(X509_OBJECT)* objs = X509_STORE_get0_objects(store);
  if (!objs) return 0;
  int n = 0;
  for (int i = 0; i < sk_X509_OBJECT_num(objs); ++i) {
    X509_OBJECT* obj = sk_X509_OBJECT_value(objs, i);
    if (obj && X509_OBJECT_get_type(obj) == X509_LU_X509) ++n;
  }
  return n;
#else
  (void)store;
  return 0;
#endif
}

// 加载单个 PEM CA 文件（若存在）。返回新增证书数；-1 = 文件不存在；-2 = 解析失败。
int add_ca_file(SSL_CTX* ctx, const std::string& path) {
  FILE* f = std::fopen(path.c_str(), "rb");
  if (!f) return -1;
  std::fclose(f);
  X509_STORE* store = SSL_CTX_get_cert_store(ctx);
  int before = count_store_certs(store);
  int rc = SSL_CTX_load_verify_locations(ctx, path.c_str(), nullptr);
  int after = count_store_certs(store);
  if (rc != 1) return -2;
  return after > before ? after - before : 0;
}

#ifdef _WIN32
// 把 Windows 证书库（CurrentUser/LocalMachine 的 ROOT/CA）里的证书加入 OpenSSL 信任库。
// 忽略单个证书解析/重复失败；返回新增数量。
int add_windows_store(X509_STORE* store, DWORD location, const wchar_t* name) {
  if (!store) return 0;
  HCERTSTORE h = CertOpenStore(CERT_STORE_PROV_SYSTEM_W, 0, 0,
                               location | CERT_STORE_READONLY_FLAG, name);
  if (!h) return 0;
  int added = 0;
  PCCERT_CONTEXT p = nullptr;
  while ((p = CertEnumCertificatesInStore(h, p)) != nullptr) {
    const unsigned char* der = p->pbCertEncoded;
    X509* x = d2i_X509(nullptr, &der, (long)p->cbCertEncoded);
    if (x) {
      if (X509_STORE_add_cert(store, x) == 1) ++added;
      X509_free(x);
    }
  }
  CertCloseStore(h, 0);
  return added;
}
#endif

// 初始化 TLS 信任链（仅一次，在 g_trust_mu 保护下调用）：
// 1) OpenSSL 默认信任路径（Linux/macOS 系统 CA；也尊重 SSL_CERT_FILE/SSL_CERT_DIR）
// 2) Windows 系统证书库（CurrentUser/LocalMachine × ROOT/CA）—— Windows 上 OPENSSLDIR 通常不存在
// 3) 程序目录本地 CA 文件：cacert.pem / cert.pem / certs/cacert.pem / data/cacert.pem
void init_tls_trust_locked(SSL_CTX* ctx) {
  X509_STORE* store = SSL_CTX_get_cert_store(ctx);
  int before = count_store_certs(store);
  SSL_CTX_set_default_verify_paths(ctx);
  int after = count_store_certs(store);
  g_trust.default_paths = after > before ? after - before : after;
#ifdef _WIN32
  g_trust.win_current_user_root =
      add_windows_store(store, CERT_SYSTEM_STORE_CURRENT_USER, L"ROOT");
  g_trust.win_current_user_ca =
      add_windows_store(store, CERT_SYSTEM_STORE_CURRENT_USER, L"CA");
  g_trust.win_local_machine_root =
      add_windows_store(store, CERT_SYSTEM_STORE_LOCAL_MACHINE, L"ROOT");
  g_trust.win_local_machine_ca =
      add_windows_store(store, CERT_SYSTEM_STORE_LOCAL_MACHINE, L"CA");
#endif
  g_trust.search_dir = platform_exe_dir();
  static const char* kCandidates[] = {"cacert.pem", "cert.pem", "certs/cacert.pem",
                                      "data/cacert.pem"};
  for (const char* cand : kCandidates) {
    const std::string path = g_trust.search_dir + "/" + cand;
    int added = add_ca_file(ctx, path);
    if (added >= 0) g_trust.local_files.emplace_back(path, added);
  }
  g_trust.initialized = true;
}

SSL_CTX* tls_ctx() {
  std::lock_guard<std::mutex> lk(g_trust_mu);
  if (g_tls_ctx) return g_tls_ctx;
  SSL_library_init();
  SSL_load_error_strings();
  OpenSSL_add_all_algorithms();
  SSL_CTX* ctx = SSL_CTX_new(TLS_client_method());
  if (ctx) {
    SSL_CTX_set_options(ctx, SSL_OP_NO_SSLv2 | SSL_OP_NO_SSLv3 | SSL_OP_NO_TLSv1 | SSL_OP_NO_TLSv1_1);
    SSL_CTX_set_verify(ctx, SSL_VERIFY_PEER, nullptr);
    init_tls_trust_locked(ctx);
  }
  g_tls_ctx = ctx;
  return g_tls_ctx;
}

} // namespace

bool tls_info(std::string& out) {
  out.clear();
  SSL_CTX* ctx = tls_ctx();  // 触发信任链初始化
  std::lock_guard<std::mutex> lk(g_trust_mu);
  out += "OpenSSL 版本: " + std::string(OpenSSL_version(OPENSSL_VERSION)) + "\n";
  const int total = count_store_certs(ctx ? SSL_CTX_get_cert_store(ctx) : nullptr);
  out += "受信任根证书总数: " + std::to_string(total) + " 个\n";
  out += "OpenSSL 默认信任路径加载: " + std::to_string(g_trust.default_paths) + " 个证书\n";
#ifdef _WIN32
  out += "Windows 系统根证书: CurrentUser\\Root=" +
         std::to_string(g_trust.win_current_user_root) + " 个, CurrentUser\\CA=" +
         std::to_string(g_trust.win_current_user_ca) + " 个, LocalMachine\\Root=" +
         std::to_string(g_trust.win_local_machine_root) + " 个, LocalMachine\\CA=" +
         std::to_string(g_trust.win_local_machine_ca) + " 个\n";
#else
  out += "Windows 系统根证书: 不适用（非 Windows 平台，使用 OpenSSL 默认系统 CA 路径）\n";
#endif
  out += "本地 CA 文件搜索目录: " + g_trust.search_dir + "\n";
  if (g_trust.local_files.empty()) {
    out += "本地 CA 文件: 未找到（可放置 cacert.pem 于程序目录）\n";
  } else {
    for (const auto& f : g_trust.local_files) {
      out += "本地 CA 文件: " + f.first + "（新增 " + std::to_string(f.second) + " 个证书）\n";
    }
  }
  if (total == 0) {
    out += "警告: 未加载到任何受信任根证书，TLS 证书校验会失败！\n";
  }
  out += "提示: 若 TLS 握手仍失败，请把 cacert.pem（PEM 格式 CA 证书包）放到程序目录，"
         "或用环境变量 SSL_CERT_FILE 指定 CA 文件。\n";
  return true;
}

#else  // !HAS_OPENSSL

bool tls_info(std::string& out) {
  out = "本程序未编译 TLS 支持（构建时未找到 OpenSSL）\n";
  return false;
}

#endif  // HAS_OPENSSL

#ifdef HAS_OPENSSL
// 配置 TLS 连接的主机名校验（SNI + 证书主机名）。
// 原实现只做证书链校验（SSL_VERIFY_PEER），不做主机名校验：
// 中间人只要有一张任意合法 CA 签发的证书就能通过握手，
// 即使证书的域名与所连服务器完全无关。这里补上主机名校验。
// 注意：IP 字面量（如 127.0.0.1、校园网邮件服务器 IP）必须用 set1_ip_asc，
// set1_host 只做 DNS 名匹配，会导致 IP 地址访问时误报“certificate verify failed”。
static bool ssl_setup_host(SSL* s, const std::string& host) {
  if (host.empty()) return false;
  unsigned char abuf[16];
  const bool is_ip = inet_pton(AF_INET, host.c_str(), abuf) == 1 ||
                     inet_pton(AF_INET6, host.c_str(), abuf) == 1;
  if (!is_ip) {
    if (SSL_set_tlsext_host_name(s, host.c_str()) != 1) return false;  // SNI（IP 不发送 SNI）
  }
  X509_VERIFY_PARAM* param = SSL_get0_param(s);
  if (!param) return false;
  X509_VERIFY_PARAM_set_hostflags(param, X509_CHECK_FLAG_NO_PARTIAL_WILDCARDS);
  if (is_ip) return X509_VERIFY_PARAM_set1_ip_asc(param, host.c_str()) == 1;
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

bool Net::skip_exact(size_t n) {
  // 丢弃 n 字节但保持接收缓冲区/协议流对齐；不分配与 n 同规模的内存。
  while (n > 0) {
    if (!buf.empty()) {
      size_t take = std::min(n, buf.size());
      buf.erase(0, take);
      n -= take;
      continue;
    }
    char tmp[8192];
    size_t want = std::min(n, sizeof tmp);
    int r = raw_recv(tmp, (int)want);
    if (r <= 0) return false;
    n -= (size_t)r;
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

// 收信内存安全边界（FEATURE-SPEC §3.2：单封解析上限 50MB）。
// 单封超限：跳过该邮件并记 seen（避免每轮重复下载）；单轮累计超预算：本轮停止，剩余下轮再取。
constexpr size_t kMaxMailBytes = 50u * 1024 * 1024;
constexpr size_t kMaxRoundBytes = 48u * 1024 * 1024;

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

bool smtp_send_raw(const SmtpConfig& cfg, const std::vector<std::string>& rcpts,
                   const std::string& raw_message, std::string& err) {
  err.clear();
  if (cfg.host.empty()) { err = "SMTP 服务器未配置"; return false; }
  // 收件人清洗：去空、去重、去 CR/LF，必须含 @
  std::vector<std::string> rc;
  for (const auto& r : rcpts) {
    std::string a = util::sanitize_header(util::trim(r));
    if (a.empty() || a.find('@') == std::string::npos) continue;
    bool dup = false;
    for (const auto& x : rc) {
      if (util::to_lower(x) == util::to_lower(a)) { dup = true; break; }
    }
    if (!dup) rc.push_back(a);
  }
  if (rc.empty()) { err = "收件人不能为空"; return false; }

  SmtpConfig c = cfg;
  Net net;
  bool used_tls = cfg.ssl;
  std::string tls_reason, cerr;
  // 配置为 SSL 但握手失败（常见于端口误勾 SSL 或本机根证书缺失）：
  // 自动回退明文 + STARTTLS 升级；失败时错误信息保留 TLS 原因。
  if (!connect_mail(net, c.host, c.port, cfg.ssl, 20000, used_tls, tls_reason, cerr)) {
    err = "无法连接 SMTP 服务器 " + c.host + ":" + std::to_string(c.port) + "：" + cerr +
          tls_fallback_note(tls_reason);
    return false;
  }
  c.ssl = used_tls;
  int code = 0;
  std::string text;
  if (!read_response(net, code, text) || code != 220) {
    err = "SMTP 问候失败: " + text + tls_fallback_note(tls_reason);
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
  if (!net.send_all("MAIL FROM:<" + from_safe + ">\r\n")) { err = "SMTP MAIL FROM 失败"; return false; }
  if (!read_response(net, code, text) || code != 250) { err = "SMTP MAIL FROM 被拒绝: " + text; return false; }
  for (const auto& to : rc) {
    if (!net.send_all("RCPT TO:<" + to + ">\r\n")) { err = "SMTP RCPT TO 失败"; return false; }
    if (!read_response(net, code, text) || (code != 250 && code != 251)) {
      err = "SMTP RCPT TO 被拒绝（" + to + "）: " + text;
      return false;
    }
  }
  if (!net.send_all("DATA\r\n")) { err = "SMTP DATA 失败"; return false; }
  if (!read_response(net, code, text) || code != 354) { err = "SMTP DATA 未接受: " + text; return false; }

  std::string data;
  size_t start = 0;
  while (start < raw_message.size()) {
    size_t e = raw_message.find('\n', start);
    std::string line = (e == std::string::npos) ? raw_message.substr(start) : raw_message.substr(start, e - start);
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

bool smtp_send(const SmtpConfig& cfg, const std::string& to_addr, const std::string& subject,
               const std::string& body, std::string& err) {
  const std::string from = cfg.from_addr.empty() ? cfg.user : cfg.from_addr;
  std::string raw = mime::build_message(cfg.display_name, from, to_addr, subject, body);
  return smtp_send_raw(cfg, std::vector<std::string>{to_addr}, raw, err);
}

FetchResult pop3_fetch(const Pop3Config& cfg, const std::set<std::string>& seen_uidls, int max_new) {
  FetchResult res;
  if (cfg.host.empty()) { res.error = "POP3 服务器未配置"; return res; }
  Net net;
  bool want_tls = cfg.ssl;
  std::string tls_reason, cerr;
  if (!connect_mail(net, cfg.host, cfg.port, cfg.ssl, 20000, want_tls, tls_reason, cerr)) {
    res.error = "无法连接 POP3 服务器 " + cfg.host + ":" + std::to_string(cfg.port) + "：" + cerr +
                tls_fallback_note(tls_reason);
    return res;
  }
  std::string line;
  if (!net.recv_line(line) || !util::starts_with(line, "+OK")) {
    res.error = "POP3 问候失败" + tls_fallback_note(tls_reason);
    return res;
  }
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
  size_t round_bytes = 0;  // 本轮已拉取字节数（含超限跳过的邮件）
  for (const auto& kv : uidl) {
    if (seen_uidls.count(kv.second)) continue;
    if ((int)res.messages.size() >= max_new) break;  // 单轮上限，剩余的下一轮再取
    if (round_bytes >= kMaxRoundBytes) break;        // 单轮累计预算用完，剩余下轮再取
    if (!net.send_all("RETR " + kv.first + "\r\n")) { res.error = "POP3 RETR 发送失败"; return res; }
    if (!net.recv_line(line) || !util::starts_with(line, "+OK")) continue; // skip broken message
    std::string raw;
    size_t msg_bytes = 0;
    bool over_limit = false;
    for (;;) {
      if (!net.recv_line(line)) { res.error = "POP3 RETR 读取中断"; return res; }
      if (line == ".") break;
      if (!line.empty() && line[0] == '.') line = line.substr(1);
      if (over_limit) continue;  // 已超单封上限：只读空到 "."，不再累积
      msg_bytes += line.size() + 2;
      if (msg_bytes > kMaxMailBytes) {  // 单封 >50MB：丢弃内容，消息仍记 seen
        over_limit = true;
        raw.clear();
        raw.shrink_to_fit();
        continue;
      }
      raw += line + "\r\n";
    }
    round_bytes += msg_bytes;
    if (over_limit) {
      res.new_keys.push_back(kv.second);  // 记 seen，避免每轮重复下载超大邮件
      continue;
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

// 从 FETCH 响应行解析 literal 大小（如 "* 1 FETCH (UID 1 BODY[] {123}"）。
// 兼容 BODY[] / BODY.PEEK[] / RFC822 等不同服务器写法：取行内 "{<digits>}" 解析。
bool parse_literal_size(const std::string& line, size_t& out) {
  auto brace = line.rfind('{');
  if (brace == std::string::npos) return false;
  auto close = line.find('}', brace + 1);
  if (close == std::string::npos) return false;
  size_t n = 0;
  bool any = false;
  for (size_t k = brace + 1; k < close; ++k) {
    if (!isdigit((unsigned char)line[k])) return false;
    n = n * 10 + (size_t)(line[k] - '0');
    any = true;
  }
  if (!any) return false;
  out = n;
  return true;
}

// 拉取单封 IMAP 邮件。out_bytes 返回该封 literal 大小；too_large 表示超过单封上限
// （此时 literal 已被读空丢弃，协议流保持对齐，调用方应把该 UID 记 seen）。
// 2.1：使用 BODY.PEEK[]（不改变服务器 \Seen），RFC822/BODY[] 会自动置已读。
bool imap_fetch_one(Net& net, const std::string& tag, int uid, std::string& raw, std::string& status,
                    size_t& out_bytes, bool& too_large) {
  // 用 UID FETCH（而不是按序号 FETCH）：序号会随邮箱压缩/删除漂移，
  // UID 在邮箱生命周期内稳定，配合 seen_uid 才能可靠去重/标已读。
  if (!net.send_all(tag + " UID FETCH " + std::to_string(uid) + " (BODY.PEEK[])\r\n")) return false;
  raw.clear();
  out_bytes = 0;
  too_large = false;
  std::string line;
  for (;;) {
    if (!net.recv_line(line)) return false;
    if (util::starts_with(line, tag + " ")) {
      std::vector<std::string> p = util::split(line, ' ');
      status = p.size() >= 2 ? p[1] : "";
      return true;
    }
    size_t n = 0;
    if (parse_literal_size(line, n) && n > 0) {
      out_bytes = n;
      if (n > kMaxMailBytes) {
        // 超大邮件：读空 literal 保持协议对齐，不分配大内存
        too_large = true;
        if (!net.skip_exact(n)) return false;
      } else {
        std::string lit_data;
        if (!net.recv_exact(lit_data, n)) return false;
        raw = std::move(lit_data);
      }
    }
  }
}

// 2.1：批量标记 \Seen（每 batch_size 个 uid 一条 UID STORE，避免逐条往返）。
// 成功（服务器返回 OK）的 uid 追加到 out_marked；失败不影响收信，保留给下次重试。
void imap_mark_seen(Net& net, const std::set<std::string>& uids, std::vector<std::string>& out_marked) {
  constexpr size_t kBatch = 50;
  std::vector<std::string> batch;
  batch.reserve(kBatch);
  auto flush = [&](int& tagseq) {
    if (batch.empty()) return;
    std::string csv;
    for (size_t i = 0; i < batch.size(); ++i) {
      if (i) csv += ",";
      csv += batch[i];
    }
    std::string tag = "ms" + std::to_string(tagseq++);
    std::string status;
    if (net.send_all(tag + " UID STORE " + csv + " +FLAGS.SILENT (\\Seen)\r\n") &&
        imap_read_until(net, tag, status, nullptr) && status == "OK") {
      for (const auto& u : batch) out_marked.push_back(u);
    }
    batch.clear();
  };
  int tagseq = 0;
  for (const auto& u : uids) {
    if (u.empty()) continue;
    batch.push_back(u);
    if (batch.size() >= kBatch) flush(tagseq);
  }
  flush(tagseq);
}

} // namespace

FetchResult imap_fetch(const ImapConfig& cfg, const std::set<std::string>& seen_uids, int max_new,
                       const std::set<std::string>& mark_seen_uids) {
  FetchResult res;
  if (cfg.host.empty()) { res.error = "IMAP 服务器未配置"; return res; }
  Net net;
  bool want_tls = cfg.ssl;
  std::string tls_reason, cerr;
  if (!connect_mail(net, cfg.host, cfg.port, cfg.ssl, 20000, want_tls, tls_reason, cerr)) {
    res.error = "无法连接 IMAP 服务器 " + cfg.host + ":" + std::to_string(cfg.port) + "：" + cerr +
                tls_fallback_note(tls_reason);
    return res;
  }
  std::string line;
  if (!net.recv_line(line) || !util::starts_with(line, "* OK")) {
    res.error = "IMAP 问候失败: " + line + tls_fallback_note(tls_reason);
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
  // 2.1：先把用户已打开会话的 UID 批量标为 \Seen（失败不影响收信，下次重试）。
  // 关键：收信本身用 BODY.PEEK[]，不会自动置已读；只有这里显式标记。
  if (!mark_seen_uids.empty()) {
    imap_mark_seen(net, mark_seen_uids, res.seen_marked);
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
  size_t round_bytes = 0;  // 本轮已拉取字节数（含超限跳过的邮件）
  for (int uid : uids) {
    std::string key = std::to_string(uid);
    if (seen_uids.count(key)) continue;
    if ((int)res.messages.size() >= max_new) break;  // 单轮上限，剩余的下一轮再取
    if (round_bytes >= kMaxRoundBytes) break;        // 单轮累计预算用完，剩余下轮再取
    std::string raw;
    std::string st;
    size_t bytes = 0;
    bool too_large = false;
    if (!imap_fetch_one(net, "a4", uid, raw, st, bytes, too_large)) {
      res.error = "IMAP FETCH 读取中断";
      return res;
    }
    round_bytes += bytes;
    if (too_large) {
      res.new_keys.push_back(key);  // 单封 >50MB：跳过并记 seen，避免每轮重复下载
      continue;
    }
    if (st != "OK" || raw.empty()) continue;
    mime::Msg m;
    mime::parse_message(raw, m);
    m.uid = key;  // 2.1：记录 IMAP UID（用于之后“打开会话=标已读”）
    res.messages.push_back(m);
    res.new_keys.push_back(key);
  }
  net.send_all("a6 LOGOUT\r\n");
  res.ok = true;
  return res;
}

bool test_smtp(const SmtpConfig& cfg, std::string& err) {
  err.clear();
  if (cfg.host.empty()) { err = "SMTP 服务器未配置"; return false; }
  SmtpConfig c = cfg;
  Net net;
  bool used_tls = cfg.ssl;
  std::string tls_reason, cerr;
  if (!connect_mail(net, c.host, c.port, cfg.ssl, 15000, used_tls, tls_reason, cerr)) {
    err = "无法连接 SMTP 服务器 " + c.host + ":" + std::to_string(c.port) + "：" + cerr +
          "（网易企业邮箱用 994+SSL，163/QQ 个人邮箱用 465+SSL）" + tls_fallback_note(tls_reason);
    return false;
  }
  c.ssl = used_tls;
  int code = 0;
  std::string text;
  if (!read_response(net, code, text) || code != 220) {
    err = "SMTP 问候失败: " + text + tls_fallback_note(tls_reason);
    return false;
  }
  if (!smtp_ehlo(net, text)) {
    err = "EHLO 失败: " + text + tls_fallback_note(tls_reason);
    return false;
  }
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
  Net net;
  bool want_tls = cfg.ssl;
  std::string tls_reason, cerr;
  if (!connect_mail(net, cfg.host, cfg.port, cfg.ssl, 15000, want_tls, tls_reason, cerr)) {
    err = "无法连接 POP3 服务器 " + cfg.host + ":" + std::to_string(cfg.port) + "：" + cerr +
          "（POP3 常用 995+SSL；也可改用 IMAP 993+SSL）" + tls_fallback_note(tls_reason);
    return false;
  }
  std::string line;
  if (!net.recv_line(line) || !util::starts_with(line, "+OK")) {
    err = "POP3 问候失败" + tls_fallback_note(tls_reason);
    return false;
  }
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
  Net net;
  bool want_tls = cfg.ssl;
  std::string tls_reason, cerr;
  if (!connect_mail(net, cfg.host, cfg.port, cfg.ssl, 15000, want_tls, tls_reason, cerr)) {
    err = "无法连接 IMAP 服务器 " + cfg.host + ":" + std::to_string(cfg.port) + "：" + cerr +
          "（IMAP 常用 993+SSL）" + tls_fallback_note(tls_reason);
    return false;
  }
  std::string line;
  if (!net.recv_line(line) || !util::starts_with(line, "* OK")) {
    err = "IMAP 问候失败" + tls_fallback_note(tls_reason);
    return false;
  }
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
    if (!net.last_error().empty()) err += "：" + net.last_error();
    return false;
  }
  std::string line;
  if (!net.recv_line(line)) { err = "已连接但服务器无响应"; return false; }
  greeting = line;
  return true;
}

} // namespace proto