#pragma once
#include <cstdint>
#include <set>
#include <string>
#include <vector>

#include "mime.hpp"

namespace proto {

struct SmtpConfig {
  std::string host;
  int port = 465;
  bool ssl = true;
  std::string user;
  std::string pass;
  std::string from_addr;
  std::string display_name;
};

struct Pop3Config {
  std::string host;
  int port = 995;
  bool ssl = true;
  std::string user;
  std::string pass;
};

struct ImapConfig {
  std::string host;
  int port = 993;
  bool ssl = true;
  std::string user;
  std::string pass;
};

// Raw socket wrapper: TCP, optional TLS on top (OpenSSL when available).
struct Net {
  intptr_t fd = -1;
  bool tls = false;
  void* ssl = nullptr; // SSL*
  std::string buf;     // receive buffer

  Net() = default;
  Net(const Net&) = delete;
  Net& operator=(const Net&) = delete;
  ~Net() { close(); }

  bool connect(const std::string& host, int port, bool use_tls, int timeout_ms);
  bool starttls(const std::string& host);  // 在已建立但未加密的连接上升级为 TLS
  bool send_all(const std::string& data);
  bool recv_line(std::string& line);
  bool recv_exact(std::string& out, size_t n);
  // 读取并丢弃 n 字节（用于跳过超大 IMAP literal，保持协议流对齐，不分配大内存）
  bool skip_exact(size_t n);
  void close();
  bool good() const { return fd >= 0; }
  // 最近一次 connect() 失败的详细原因（DNS / TCP / TLS 哪一层）
  const std::string& last_error() const { return last_error_; }

  static bool has_tls();

 private:
  int raw_recv(char* p, int n);
  std::string last_error_;
};

struct FetchResult {
  bool ok = false;
  std::string error;
  std::vector<mime::Msg> messages;
  std::vector<std::string> new_keys;   // uidl/uid values that were processed successfully
  std::vector<std::string> seen_marked;  // 2.1：本次成功 STORE +FLAGS (\Seen) 的 IMAP UID
};

bool smtp_send(const SmtpConfig& cfg, const std::string& to_addr, const std::string& subject,
               const std::string& body, std::string& err);

// 发送已组装好的原始 MIME 报文，支持多收件人（to + cc + bcc，SMTP 信封收件人）。
// 旧 smtp_send 保留（内部走 raw + 单个 rcpt），供旧测试/兼容。
bool smtp_send_raw(const SmtpConfig& cfg, const std::vector<std::string>& rcpts,
                   const std::string& raw_message, std::string& err);

// POP3: fetch messages whose UIDL is not in seen_uidls.
// max_new 限制单轮最多取回的新邮件数（防止一次拉爆，剩余下轮再取）。
FetchResult pop3_fetch(const Pop3Config& cfg, const std::set<std::string>& seen_uidls,
                       int max_new = 300);

// IMAP 收信：拉取未读邮件（BODY.PEEK[]，不改变服务器 \Seen 状态）。
// mark_seen_uids：本轮需要批量标记为 \Seen 的 UID（用户打开会话时才传入；
// 在 SELECT 后、FETCH 前批量 UID STORE，每 ~50 个一条命令）。
// 仅成功标记的 uid 会出现在 FetchResult::seen_marked 中，供调用方清理 pending。
FetchResult imap_fetch(const ImapConfig& cfg, const std::set<std::string>& seen_uids,
                       int max_new = 300,
                       const std::set<std::string>& mark_seen_uids = {});

// Connection/login tests (no mail transferred).
bool test_smtp(const SmtpConfig& cfg, std::string& err);
bool test_pop3(const Pop3Config& cfg, std::string& err);
bool test_imap(const ImapConfig& cfg, std::string& err);

// TLS 信任链诊断（--tls-info）：OpenSSL 版本、Windows 系统根证书库加载数、
// 程序目录本地 CA 文件、受信任根证书总数。返回 false 表示本构建未启用 TLS。
bool tls_info(std::string& out);

// 仅建立连接并读取服务器问候语（不做登录），用于「自动检测服务器」：
// 成功时 greeting 形如 "220 ..."/"+OK ..."/"* OK ..."。
bool probe_greeting(const std::string& host, int port, bool ssl, int timeout_ms,
                    std::string& greeting, std::string& err);

} // namespace proto