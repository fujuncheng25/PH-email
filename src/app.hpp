#pragma once
#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <map>
#include <mutex>
#include <set>
#include <string>
#include <thread>
#include <vector>

#include "http.hpp"
#include "mime.hpp"
#include "proto.hpp"
#include "util.hpp"

namespace app {

struct Friend {
  std::string email;
  std::string name;
  std::string note;
  int64_t added_at = 0;
};

struct Message {
  int64_t id = 0;
  std::string dir; // "in" | "out"
  std::string text;
  int64_t ts = 0;
  std::string mid; // Message-ID（收件去重用，可为空）
};

struct Account {
  std::string email;
  std::string display_name;
  std::string password;
  std::string mode = "imap"; // "imap" | "pop3"
  proto::ImapConfig imap;
  proto::Pop3Config pop3;
  proto::SmtpConfig smtp;
  int poll_interval = 8;
  bool auto_poll = true; // 自动收信开关
};

class Store {
 public:
  std::string data_dir;
  Account account;
  std::vector<Friend> friends;
  std::map<std::string, std::vector<Message>> conversations;
  std::map<std::string, int> unread;
  std::set<std::string> seen_pop3;
  std::set<std::string> seen_imap;
  int64_t next_msg_id = 1;

  bool load(std::string& err);
  bool save_config(std::string& err);
  bool save_messages(std::string& err);

  bool is_friend(const std::string& email) const;
  Friend* find_friend(const std::string& email);
  const Friend* find_friend(const std::string& email) const;
  std::string friend_name(const std::string& email) const;
  bool add_friend(const std::string& email, const std::string& name, const std::string& note);
  bool remove_friend(const std::string& email);
  // 新增一条消息；返回 true 表示真正写入（按 Message-ID 去重，重复时返回 false）
  bool add_message(const std::string& peer, const std::string& dir, const std::string& text, int64_t ts,
                   const std::string& mid = "");
  void mark_read(const std::string& peer);
  std::string last_text(const std::string& peer) const;
  int64_t last_ts(const std::string& peer) const;
};

class App {
 public:
  App() = default;
  ~App();

  bool init(const std::string& data_dir, const std::string& web_dir, const std::string& bind_host,
            int port, std::string& err);
  void start_threads();
  void stop();
  int bound_port() const { return port_; }
  bool running_now() const { return running.load(); }

  void trigger_poll();
  bool poll_once(std::string& err);

  std::string api_state();
  std::string api_messages(const std::string& peer);
  std::string api_send(const std::string& to, const std::string& text);
  std::string api_read(const std::string& peer);
  std::string api_friends(const util::Json& body);
  std::string api_config(const util::Json& body);
  std::string api_test();
  std::string api_probe(const util::Json& body);
  std::string api_poll();

  // CSRF / DNS-rebinding 防护：校验请求 Host 与 Origin 是否可信
  bool api_guard(const http::Request& req) const;

  Store store;
  std::mutex mtx;
  std::atomic<bool> running{false};

 private:
  void run_poller();
  http::Handler make_handler();

  bool force_poll = false;
  std::condition_variable cv;
  std::thread poller_thread;
  std::thread http_thread;
  intptr_t listen_fd = -1;
  int port_ = 0;
  std::string bind_host_ = "127.0.0.1";
  std::string web_dir_;
  http::Handler handler_;
  struct PollStatus {
    int64_t last_ts = 0;
    bool ok = false;
    std::string error;
    int fetched = 0;
    int skipped = 0;
  } poll_status;
};

} // namespace app