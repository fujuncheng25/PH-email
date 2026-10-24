#include "app.hpp"

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <system_error>

#ifdef _WIN32
#include <direct.h>
#include <io.h>
#define MKDIR(p) _mkdir(p)
#else
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>
#define MKDIR(p) ::mkdir(p, 0755)
#endif

namespace app {

namespace {

bool file_exists(const std::string& path) {
  std::ifstream f(path);
  return f.good();
}

bool ensure_dir(const std::string& dir) {
  if (dir.empty()) return false;
  std::error_code ec;
  if (std::filesystem::is_directory(dir, ec)) return true;
  std::filesystem::create_directories(dir, ec);
  if (ec) return false;
  return std::filesystem::is_directory(dir, ec);
}

bool write_file(const std::string& path, const std::string& content) {
  std::string tmp = path + ".tmp";
  {
    std::ofstream f(tmp, std::ios::binary | std::ios::trunc);
    if (!f) return false;
    f.write(content.data(), (std::streamsize)content.size());
    if (!f) return false;
  }
  std::remove(path.c_str());
  return std::rename(tmp.c_str(), path.c_str()) == 0;
}

std::string truncate_utf8(const std::string& s, size_t max_bytes) {
  if (s.size() <= max_bytes) return s;
  size_t n = max_bytes;
  while (n > 0 && ((unsigned char)s[n] & 0xC0) == 0x80) --n;
  return s.substr(0, n);
}

std::string jstr(const util::Json& o, const char* k, const std::string& def = "") {
  const util::Json* v = o.get(k);
  return v ? v->as_string(def) : def;
}
int jint(const util::Json& o, const char* k, int def) {
  const util::Json* v = o.get(k);
  return v ? (int)v->as_int64(def) : def;
}
bool jbool(const util::Json& o, const char* k, bool def) {
  const util::Json* v = o.get(k);
  return v ? v->as_bool(def) : def;
}

std::string json_ok() {
  util::Json r = util::Json::make_object();
  r["ok"] = util::Json::make_bool(true);
  return r.dump();
}

std::string json_err(const std::string& msg) {
  util::Json r = util::Json::make_object();
  r["ok"] = util::Json::make_bool(false);
  r["error"] = util::Json::make_string(msg);
  return r.dump();
}

std::string url_decode(const std::string& s) {
  std::string out;
  for (size_t i = 0; i < s.size(); ++i) {
    char c = s[i];
    if (c == '+') out += ' ';
    else if (c == '%' && i + 2 < s.size()) {
      auto hex = [](char h) -> int {
        if (h >= '0' && h <= '9') return h - '0';
        if (h >= 'a' && h <= 'f') return h - 'a' + 10;
        if (h >= 'A' && h <= 'F') return h - 'A' + 10;
        return -1;
      };
      int a = hex(s[i + 1]), b = hex(s[i + 2]);
      if (a >= 0 && b >= 0) {
        out += (char)((a << 4) | b);
        i += 2;
      } else {
        out += c;
      }
    } else {
      out += c;
    }
  }
  return out;
}

std::string query_param(const std::string& query, const std::string& name) {
  size_t pos = 0;
  while (pos < query.size()) {
    size_t amp = query.find('&', pos);
    std::string kv = (amp == std::string::npos) ? query.substr(pos) : query.substr(pos, amp - pos);
    auto eq = kv.find('=');
    if (eq != std::string::npos) {
      if (kv.substr(0, eq) == name) return url_decode(kv.substr(eq + 1));
    }
    if (amp == std::string::npos) break;
    pos = amp + 1;
  }
  return "";
}

} // namespace

// ============================== Store ==============================

std::string config_path_of(const std::string& data_dir) { return data_dir + "/config.json"; }
std::string messages_path_of(const std::string& data_dir) { return data_dir + "/messages.json"; }

bool Store::load(std::string& err) {
  err.clear();
  account = Account();
  friends.clear();
  conversations.clear();
  unread.clear();
  seen_pop3.clear();
  seen_imap.clear();
  next_msg_id = 1;

  const std::string cpath = config_path_of(data_dir);
  const std::string mpath = messages_path_of(data_dir);

  std::string perr;
  util::Json cfg = util::Json::parse_file(cpath, &perr);
  if (!cfg.is_object()) {
    if (file_exists(cpath)) {
      err = "配置文件解析失败: " + perr;
      return false;
    }
  } else {
    account.email = util::to_lower(util::trim(jstr(cfg, "email")));
    account.display_name = jstr(cfg, "display_name");
    account.password = jstr(cfg, "password");
    account.mode = jstr(cfg, "mode", "imap");
    if (account.mode != "imap" && account.mode != "pop3") account.mode = "imap";
    account.poll_interval = jint(cfg, "poll_interval", 8);
    if (account.poll_interval < 3) account.poll_interval = 3;
    account.auto_poll = jbool(cfg, "auto_poll", true);

    if (const util::Json* im = cfg.get("imap")) {
      int p = jint(*im, "port", 993);
      account.imap.host = util::normalize_host(jstr(*im, "host"), p);
      account.imap.port = p;
      account.imap.ssl = jbool(*im, "ssl", true);
    }
    if (const util::Json* pp = cfg.get("pop3")) {
      int p = jint(*pp, "port", 995);
      account.pop3.host = util::normalize_host(jstr(*pp, "host"), p);
      account.pop3.port = p;
      account.pop3.ssl = jbool(*pp, "ssl", true);
    }
    if (const util::Json* sm = cfg.get("smtp")) {
      int p = jint(*sm, "port", 465);
      account.smtp.host = util::normalize_host(jstr(*sm, "host"), p);
      account.smtp.port = p;
      account.smtp.ssl = jbool(*sm, "ssl", true);
    }

    if (const util::Json* fr = cfg.get("friends"); fr && fr->is_array()) {
      for (const auto& item : fr->arr) {
        Friend f;
        f.email = util::to_lower(util::trim(jstr(item, "email")));
        f.name = jstr(item, "name");
        f.note = jstr(item, "note");
        f.added_at = item.get("added_at") ? item.get("added_at")->as_int64(0) : 0;
        if (!f.email.empty()) friends.push_back(f);
      }
    }
    if (const util::Json* sp = cfg.get("seen_pop3"); sp && sp->is_array()) {
      for (const auto& item : sp->arr) seen_pop3.insert(item.as_string());
    }
    if (const util::Json* si = cfg.get("seen_imap"); si && si->is_array()) {
      for (const auto& item : si->arr) seen_imap.insert(item.as_string());
    }
    if (const util::Json* un = cfg.get("unread"); un && un->is_object()) {
      for (const auto& kv : un->obj) unread[kv.first] = (int)kv.second.as_int64(0);
    }
    next_msg_id = jint(cfg, "next_msg_id", 1);
    if (next_msg_id < 1) next_msg_id = 1;
  }

  std::string merr;
  util::Json msgs = util::Json::parse_file(mpath, &merr);
  if (msgs.is_object()) {
    if (const util::Json* convs = msgs.get("conversations"); convs && convs->is_object()) {
      for (const auto& kv : convs->obj) {
        if (!kv.second.is_array()) continue;
        std::vector<Message> list;
        for (const auto& item : kv.second.arr) {
          Message m;
          m.id = item.get("id") ? item.get("id")->as_int64(0) : 0;
          m.dir = jstr(item, "dir");
          m.text = jstr(item, "text");
          m.ts = item.get("ts") ? item.get("ts")->as_int64(0) : 0;
          m.mid = jstr(item, "mid");
          list.push_back(m);
        }
        if (!list.empty()) conversations[kv.first] = list;
      }
    }
  }
  return true;
}

bool Store::save_config(std::string& err) {
  err.clear();
  util::Json cfg = util::Json::make_object();
  cfg["email"] = util::Json::make_string(account.email);
  cfg["display_name"] = util::Json::make_string(account.display_name);
  cfg["password"] = util::Json::make_string(account.password);
  cfg["mode"] = util::Json::make_string(account.mode);
  cfg["poll_interval"] = util::Json::make_number(account.poll_interval);
  cfg["auto_poll"] = util::Json::make_bool(account.auto_poll);

  util::Json im = util::Json::make_object();
  im["host"] = util::Json::make_string(account.imap.host);
  im["port"] = util::Json::make_number(account.imap.port);
  im["ssl"] = util::Json::make_bool(account.imap.ssl);
  cfg["imap"] = im;

  util::Json pp = util::Json::make_object();
  pp["host"] = util::Json::make_string(account.pop3.host);
  pp["port"] = util::Json::make_number(account.pop3.port);
  pp["ssl"] = util::Json::make_bool(account.pop3.ssl);
  cfg["pop3"] = pp;

  util::Json sm = util::Json::make_object();
  sm["host"] = util::Json::make_string(account.smtp.host);
  sm["port"] = util::Json::make_number(account.smtp.port);
  sm["ssl"] = util::Json::make_bool(account.smtp.ssl);
  cfg["smtp"] = sm;

  util::Json fr = util::Json::make_array();
  for (const auto& f : friends) {
    util::Json item = util::Json::make_object();
    item["email"] = util::Json::make_string(f.email);
    item["name"] = util::Json::make_string(f.name);
    item["note"] = util::Json::make_string(f.note);
    item["added_at"] = util::Json::make_number((double)f.added_at);
    fr.arr.push_back(item);
  }
  cfg["friends"] = fr;

  util::Json sp = util::Json::make_array();
  for (const auto& k : seen_pop3) sp.arr.push_back(util::Json::make_string(k));
  cfg["seen_pop3"] = sp;

  util::Json si = util::Json::make_array();
  for (const auto& k : seen_imap) si.arr.push_back(util::Json::make_string(k));
  cfg["seen_imap"] = si;

  util::Json un = util::Json::make_object();
  for (const auto& kv : unread) un[kv.first] = util::Json::make_number(kv.second);
  cfg["unread"] = un;
  cfg["next_msg_id"] = util::Json::make_number((double)next_msg_id);

  if (!write_file(config_path_of(data_dir), cfg.dump())) {
    err = "保存配置文件失败: " + config_path_of(data_dir);
    return false;
  }
  return true;
}

bool Store::save_messages(std::string& err) {
  err.clear();
  util::Json root = util::Json::make_object();
  util::Json convs = util::Json::make_object();
  for (const auto& kv : conversations) {
    util::Json arr = util::Json::make_array();
    for (const auto& m : kv.second) {
      util::Json item = util::Json::make_object();
      item["id"] = util::Json::make_number((double)m.id);
      item["dir"] = util::Json::make_string(m.dir);
      item["text"] = util::Json::make_string(m.text);
      item["ts"] = util::Json::make_number((double)m.ts);
      if (!m.mid.empty()) item["mid"] = util::Json::make_string(m.mid);
      arr.arr.push_back(item);
    }
    convs[kv.first] = arr;
  }
  root["conversations"] = convs;
  if (!write_file(messages_path_of(data_dir), root.dump())) {
    err = "保存消息文件失败: " + messages_path_of(data_dir);
    return false;
  }
  return true;
}

bool Store::is_friend(const std::string& email) const {
  return find_friend(util::to_lower(util::trim(email))) != nullptr;
}
const Friend* Store::find_friend(const std::string& email) const {
  std::string e = util::to_lower(util::trim(email));
  for (const auto& f : friends) {
    if (f.email == e) return &f;
  }
  return nullptr;
}
Friend* Store::find_friend(const std::string& email) {
  std::string e = util::to_lower(util::trim(email));
  for (auto& f : friends) {
    if (f.email == e) return &f;
  }
  return nullptr;
}
std::string Store::friend_name(const std::string& email) const {
  const Friend* f = find_friend(email);
  if (f && !f->name.empty()) return f->name;
  return email;
}
bool Store::add_friend(const std::string& email, const std::string& name, const std::string& note) {
  std::string e = util::to_lower(util::trim(email));
  if (e.empty() || e.find('@') == std::string::npos) return false;
  Friend* existing = find_friend(e);
  if (existing) {
    if (!name.empty()) existing->name = name;
    if (!note.empty()) existing->note = note;
    return true;
  }
  Friend f;
  f.email = e;
  f.name = name;
  f.note = note;
  f.added_at = util::now_epoch();
  friends.push_back(f);
  return true;
}
bool Store::remove_friend(const std::string& email) {
  std::string e = util::to_lower(util::trim(email));
  for (size_t i = 0; i < friends.size(); ++i) {
    if (friends[i].email == e) {
      friends.erase(friends.begin() + (long)i);
      conversations.erase(e);
      unread.erase(e);
      return true;
    }
  }
  return false;
}
bool Store::add_message(const std::string& peer, const std::string& dir, const std::string& text, int64_t ts,
                        const std::string& mid) {
  std::string t = truncate_utf8(util::trim(text), 4000);
  if (t.empty()) t = "(空消息)";
  // 收件按 Message-ID 去重：POP3 的 seen 表清空/损坏/换机重拉时，
  // 同一封邮件（同 Message-ID）不应在对话里出现两次。
  if (dir == "in" && !mid.empty()) {
    auto& conv = conversations[peer];
    for (const auto& m : conv) {
      if (m.dir == "in" && !m.mid.empty() && m.mid == mid) return false;
    }
  }
  Message m;
  m.id = next_msg_id++;
  m.dir = dir;
  m.text = t;
  m.ts = ts > 0 ? ts : util::now_epoch();
  m.mid = mid;
  auto& conv = conversations[peer];
  conv.push_back(m);
  if (conv.size() > 300) conv.erase(conv.begin(), conv.begin() + (long)(conv.size() - 300));
  return true;
}
void Store::mark_read(const std::string& peer) { unread.erase(peer); }
std::string Store::last_text(const std::string& peer) const {
  auto it = conversations.find(peer);
  if (it == conversations.end() || it->second.empty()) return "";
  return it->second.back().text;
}
int64_t Store::last_ts(const std::string& peer) const {
  auto it = conversations.find(peer);
  if (it == conversations.end() || it->second.empty()) return 0;
  return it->second.back().ts;
}

// ============================== App ==============================

App::~App() { stop(); }

bool App::init(const std::string& data_dir, const std::string& web_dir, const std::string& bind_host,
               int port, std::string& err) {
  err.clear();
  store.data_dir = data_dir;
  web_dir_ = web_dir;
  bind_host_ = bind_host;
  if (!ensure_dir(data_dir)) {
    err = "无法创建数据目录: " + data_dir;
    return false;
  }
  std::string lerr;
  if (!store.load(lerr)) {
    err = lerr;
    return false;
  }
  std::string herr;
  if (!http::listen(bind_host, port, listen_fd, port_, herr)) {
    err = herr;
    return false;
  }
  return true;
}

void App::start_threads() {
  running = true;
  handler_ = make_handler();
  poller_thread = std::thread([this] { run_poller(); });
  http_thread = std::thread([this] { http::run_loop(listen_fd, web_dir_, handler_); });
}

void App::stop() {
  if (!running.exchange(false)) {
    if (poller_thread.joinable()) poller_thread.join();
    if (http_thread.joinable()) http_thread.join();
    return;
  }
  cv.notify_all();
  if (listen_fd >= 0) {
    http::shutdown(listen_fd);
    listen_fd = -1;
  }
  if (poller_thread.joinable()) poller_thread.join();
  if (http_thread.joinable()) http_thread.join();
}

void App::trigger_poll() {
  {
    std::lock_guard lk(mtx);
    force_poll = true;
  }
  cv.notify_all();
}

void App::run_poller() {
  while (running) {
    int interval;
    bool auto_poll;
    {
      std::lock_guard lk(mtx);
      interval = store.account.poll_interval;
      if (interval < 3) interval = 3;
      auto_poll = store.account.auto_poll;
    }
    {
      std::unique_lock lk(mtx);
      // 关闭自动收信后，只在本机「立即收信」按钮触发时才轮询
      if (!auto_poll) {
        cv.wait(lk, [this] { return !running.load() || force_poll; });
      } else {
        cv.wait_for(lk, std::chrono::seconds(interval), [this] { return !running.load() || force_poll; });
      }
      force_poll = false;
      lk.unlock();
    }
    if (!running) break;
    std::string err;
    poll_once(err);
  }
}

bool App::poll_once(std::string& err) {
  err.clear();
  proto::ImapConfig ic;
  proto::Pop3Config pc;
  std::string mode, email, pass;
  std::set<std::string> seen_p, seen_i;
  {
    std::lock_guard lk(mtx);
    ic = store.account.imap;
    pc = store.account.pop3;
    mode = store.account.mode;
    email = store.account.email;
    pass = store.account.password;
    seen_p = store.seen_pop3;
    seen_i = store.seen_imap;
  }
  ic.user = ic.pass = "";
  pc.user = pc.pass = "";

  if (email.empty() || pass.empty()) {
    std::lock_guard lk(mtx);
    poll_status.last_ts = util::now_epoch();
    poll_status.ok = false;
    poll_status.error = "尚未配置邮箱账户";
    poll_status.fetched = poll_status.skipped = 0;
    return false;
  }
  const bool use_pop3 = (mode == "pop3");
  if (use_pop3 && pc.host.empty()) {
    std::lock_guard lk(mtx);
    poll_status.last_ts = util::now_epoch();
    poll_status.ok = false;
    poll_status.error = "尚未配置 POP3 服务器";
    poll_status.fetched = poll_status.skipped = 0;
    return false;
  }
  if (!use_pop3 && ic.host.empty()) {
    std::lock_guard lk(mtx);
    poll_status.last_ts = util::now_epoch();
    poll_status.ok = false;
    poll_status.error = "尚未配置 IMAP 服务器";
    poll_status.fetched = poll_status.skipped = 0;
    return false;
  }

  proto::FetchResult fr;
  if (use_pop3) {
    pc.user = email;
    pc.pass = pass;
    fr = proto::pop3_fetch(pc, seen_p);
  } else {
    ic.user = email;
    ic.pass = pass;
    fr = proto::imap_fetch(ic, seen_i);
  }

  int fetched = 0, skipped = 0;
  if (fr.ok) {
    bool seen_changed = false;
    std::lock_guard lk(mtx);
    for (const auto& m : fr.messages) {
      if (m.from_addr.empty() || m.from_addr == email) { skipped++; continue; }
      if (!store.is_friend(m.from_addr)) { skipped++; continue; }
      if (store.add_message(m.from_addr, "in", m.body_text, m.date_epoch, m.message_id)) {
        store.unread[m.from_addr] += 1;
        fetched++;
      } else {
        skipped++;
      }
    }
    if (use_pop3) {
      for (const auto& k : fr.new_keys) { store.seen_pop3.insert(k); seen_changed = true; }
      // seen 表超过阈值时裁掉最旧一半而不是整体清空：
      // 整体清空会让 POP3 用户把所有历史邮件重拉一遍，对话被重复消息灌满
      while (store.seen_pop3.size() > 5000) {
        auto it = store.seen_pop3.begin();
        std::advance(it, (long)(store.seen_pop3.size() / 2));
        store.seen_pop3.erase(store.seen_pop3.begin(), it);
        seen_changed = true;
      }
    } else {
      for (const auto& k : fr.new_keys) { store.seen_imap.insert(k); seen_changed = true; }
      while (store.seen_imap.size() > 5000) {
        auto it = store.seen_imap.begin();
        std::advance(it, (long)(store.seen_imap.size() / 2));
        store.seen_imap.erase(store.seen_imap.begin(), it);
        seen_changed = true;
      }
    }
    std::string serr;
    if (fetched > 0) store.save_messages(serr);
    // 只在真正有变化时才写配置，避免每 8 秒无条件磁盘写入
    if (seen_changed || fetched > 0) store.save_config(serr);
    poll_status.last_ts = util::now_epoch();
    poll_status.ok = true;
    poll_status.error.clear();
    poll_status.fetched = fetched;
    poll_status.skipped = skipped;
  } else {
    std::lock_guard lk(mtx);
    poll_status.last_ts = util::now_epoch();
    poll_status.ok = false;
    poll_status.error = fr.error;
    poll_status.fetched = poll_status.skipped = 0;
    err = fr.error;
  }
  if (!fr.ok) err = fr.error;
  return fr.ok;
}

std::string App::api_state() {
  std::lock_guard lk(mtx);
  util::Json root = util::Json::make_object();
  root["self"] = util::Json::make_string(store.account.email);
  const bool configured = !store.account.email.empty() && !store.account.password.empty();
  root["configured"] = util::Json::make_bool(configured);

  util::Json acc = util::Json::make_object();
  acc["email"] = util::Json::make_string(store.account.email);
  acc["display_name"] = util::Json::make_string(store.account.display_name);
  acc["password"] = util::Json::make_string(store.account.password);
  acc["mode"] = util::Json::make_string(store.account.mode);
  acc["poll_interval"] = util::Json::make_number(store.account.poll_interval);
  acc["auto_poll"] = util::Json::make_bool(store.account.auto_poll);
  util::Json im = util::Json::make_object();
  im["host"] = util::Json::make_string(store.account.imap.host);
  im["port"] = util::Json::make_number(store.account.imap.port);
  im["ssl"] = util::Json::make_bool(store.account.imap.ssl);
  acc["imap"] = im;
  util::Json pp = util::Json::make_object();
  pp["host"] = util::Json::make_string(store.account.pop3.host);
  pp["port"] = util::Json::make_number(store.account.pop3.port);
  pp["ssl"] = util::Json::make_bool(store.account.pop3.ssl);
  acc["pop3"] = pp;
  util::Json sm = util::Json::make_object();
  sm["host"] = util::Json::make_string(store.account.smtp.host);
  sm["port"] = util::Json::make_number(store.account.smtp.port);
  sm["ssl"] = util::Json::make_bool(store.account.smtp.ssl);
  acc["smtp"] = sm;
  root["account"] = acc;

  util::Json poll = util::Json::make_object();
  poll["last_ts"] = util::Json::make_number((double)poll_status.last_ts);
  poll["ok"] = util::Json::make_bool(poll_status.ok);
  poll["error"] = util::Json::make_string(poll_status.error);
  poll["fetched"] = util::Json::make_number(poll_status.fetched);
  poll["skipped"] = util::Json::make_number(poll_status.skipped);
  root["poll"] = poll;

  std::vector<std::pair<int64_t, const Friend*>> sorted;
  for (const auto& f : store.friends) sorted.emplace_back(store.last_ts(f.email), &f);
  std::sort(sorted.begin(), sorted.end(), [](const std::pair<int64_t, const Friend*>& a,
                                             const std::pair<int64_t, const Friend*>& b) {
    return a.first > b.first;
  });
  util::Json fs = util::Json::make_array();
  for (const auto& sp : sorted) {
    const Friend& f = *sp.second;
    util::Json item = util::Json::make_object();
    item["email"] = util::Json::make_string(f.email);
    item["name"] = util::Json::make_string(f.name);
    item["note"] = util::Json::make_string(f.note);
    auto ui = store.unread.find(f.email);
    item["unread"] = util::Json::make_number(ui == store.unread.end() ? 0 : ui->second);
    item["last_text"] = util::Json::make_string(store.last_text(f.email));
    item["last_ts"] = util::Json::make_number((double)store.last_ts(f.email));
    fs.arr.push_back(item);
  }
  root["friends"] = fs;
  return root.dump();
}

std::string App::api_messages(const std::string& peer) {
  std::lock_guard lk(mtx);
  std::string p = util::to_lower(util::trim(peer));
  util::Json root = util::Json::make_object();
  root["peer"] = util::Json::make_string(p);
  const Friend* f = store.find_friend(p);
  if (f) {
    util::Json fj = util::Json::make_object();
    fj["email"] = util::Json::make_string(f->email);
    fj["name"] = util::Json::make_string(f->name);
    fj["note"] = util::Json::make_string(f->note);
    root["friend"] = fj;
  }
  util::Json arr = util::Json::make_array();
  auto it = store.conversations.find(p);
  if (it != store.conversations.end()) {
    for (const auto& m : it->second) {
      util::Json item = util::Json::make_object();
      item["id"] = util::Json::make_number((double)m.id);
      item["dir"] = util::Json::make_string(m.dir);
      item["text"] = util::Json::make_string(m.text);
      item["ts"] = util::Json::make_number((double)m.ts);
      item["time"] = util::Json::make_string(util::format_local(m.ts));
      arr.arr.push_back(item);
    }
  }
  root["messages"] = arr;
  return root.dump();
}

std::string App::api_send(const std::string& to, const std::string& text) {
  std::string peer = util::to_lower(util::trim(to));
  std::string msg = util::trim(text);
  if (peer.empty() || msg.empty()) return json_err("收件人或内容为空");
  proto::SmtpConfig cfg;
  {
    std::lock_guard lk(mtx);
    if (!store.is_friend(peer)) return json_err("对方不在好友白名单中，无法发送");
    if (store.account.email.empty() || store.account.password.empty()) {
      return json_err("请先在设置中填写邮箱账户与客户端授权密码");
    }
    cfg.host = store.account.smtp.host;
    cfg.port = store.account.smtp.port;
    cfg.ssl = store.account.smtp.ssl;
    cfg.user = store.account.email;
    cfg.pass = store.account.password;
    cfg.from_addr = store.account.email;
    cfg.display_name = store.account.display_name.empty() ? store.account.email : store.account.display_name;
  }
  if (cfg.host.empty()) return json_err("请先在设置中配置 SMTP 服务器");
  std::string err;
  if (!proto::smtp_send(cfg, peer, "email-chatter 消息", msg, err)) return json_err(err);
  {
    std::lock_guard lk(mtx);
    store.add_message(peer, "out", msg, util::now_epoch());
    store.save_messages(err);
  }
  return json_ok();
}

std::string App::api_read(const std::string& peer) {
  {
    std::lock_guard lk(mtx);
    store.mark_read(util::to_lower(util::trim(peer)));
    std::string err;
    store.save_config(err);
  }
  return json_ok();
}

std::string App::api_friends(const util::Json& body) {
  std::string action = jstr(body, "action");
  std::string email = util::to_lower(util::trim(jstr(body, "email")));
  std::string name = jstr(body, "name");
  std::string note = jstr(body, "note");
  {
    std::lock_guard lk(mtx);
    if (action == "add") {
      if (email.find('@') == std::string::npos) return json_err("邮箱地址格式不正确");
      if (!store.add_friend(email, name, note)) return json_err("添加好友失败");
    } else if (action == "remove") {
      if (!store.remove_friend(email)) return json_err("该邮箱不在好友列表中");
    } else {
      return json_err("未知操作");
    }
    std::string err;
    if (!store.save_config(err)) return json_err(err);
  }
  return json_ok();
}

std::string App::api_config(const util::Json& body) {
  // 只覆盖请求中实际提供的字段，避免「保存一个开关」把邮箱/密码等未传字段清空
  const std::string email = util::to_lower(util::trim(body.has("email") ? jstr(body, "email") : ""));
  if (!email.empty() && email.find('@') == std::string::npos) return json_err("邮箱地址格式不正确");
  {
    std::lock_guard lk(mtx);
    if (body.has("email")) store.account.email = email;
    if (body.has("display_name")) store.account.display_name = jstr(body, "display_name");
    if (body.has("password")) store.account.password = jstr(body, "password");
    if (body.has("mode")) {
      std::string mode = jstr(body, "mode", "imap");
      store.account.mode = (mode == "pop3") ? "pop3" : "imap";
    }
    int interval = jint(body, "poll_interval", store.account.poll_interval);
    if (interval < 3) interval = 3;
    if (interval > 3600) interval = 3600;
    store.account.poll_interval = interval;
    if (body.has("auto_poll")) store.account.auto_poll = jbool(body, "auto_poll", true);
    if (const util::Json* im = body.get("imap")) {
      int p = jint(*im, "port", store.account.imap.port);
      store.account.imap.host = util::normalize_host(jstr(*im, "host"), p);
      store.account.imap.port = p;
      store.account.imap.ssl = jbool(*im, "ssl", true);
    }
    if (const util::Json* pp = body.get("pop3")) {
      int p = jint(*pp, "port", store.account.pop3.port);
      store.account.pop3.host = util::normalize_host(jstr(*pp, "host"), p);
      store.account.pop3.port = p;
      store.account.pop3.ssl = jbool(*pp, "ssl", true);
    }
    if (const util::Json* sm = body.get("smtp")) {
      int p = jint(*sm, "port", store.account.smtp.port);
      store.account.smtp.host = util::normalize_host(jstr(*sm, "host"), p);
      store.account.smtp.port = p;
      store.account.smtp.ssl = jbool(*sm, "ssl", true);
    }
    std::string err;
    if (!store.save_config(err)) return json_err(err);
  }
  trigger_poll();
  return json_ok();
}

namespace {

struct ProbeCand {
  std::string kind, host;
  int port = 0;
  bool ssl = true;
};

void add_cand(std::vector<ProbeCand>& list, const std::string& kind, const std::string& host,
              int port, bool ssl) {
  ProbeCand c;
  c.kind = kind;
  c.host = host;
  c.port = port;
  c.ssl = ssl;
  list.push_back(c);
}

// 按域名扩展出常见候选：网易企业邮箱 hz 节点 → 通用域名 → 该域名下的常规主机名
void auto_candidates(const std::string& dom, std::vector<ProbeCand>& list) {
  if (dom.empty()) return;
  add_cand(list, "imap", "imaphz.qiye.163.com", 993, true);
  add_cand(list, "imap", "imap.qiye.163.com", 993, true);
  add_cand(list, "imap", "imap." + dom, 993, true);
  add_cand(list, "imap", "imap." + dom, 143, false);
  add_cand(list, "pop3", "pophz.qiye.163.com", 995, true);
  add_cand(list, "pop3", "pop.qiye.163.com", 995, true);
  add_cand(list, "pop3", "pop." + dom, 995, true);
  add_cand(list, "pop3", "pop." + dom, 110, false);
  add_cand(list, "smtp", "smtphz.qiye.163.com", 994, true);
  add_cand(list, "smtp", "smtp.qiye.163.com", 994, true);
  add_cand(list, "smtp", "smtp.qiye.163.com", 465, true);
  add_cand(list, "smtp", "smtp." + dom, 465, true);
  add_cand(list, "smtp", "smtp." + dom, 587, false);
  add_cand(list, "smtp", "smtp." + dom, 25, false);
}

// 并发探测一组候选，返回 {"ok":true,"results":[...]} 的 JSON 文本
std::string probe_candidates_json(const std::vector<ProbeCand>& list) {
  struct Result {
    ProbeCand c;
    bool ok = false;
    std::string error, greeting;
    int elapsed_ms = 0;
  };
  std::vector<Result> results(list.size());
  std::vector<std::thread> threads;
  threads.reserve(list.size());
  for (size_t i = 0; i < list.size(); ++i) {
    results[i].c = list[i];
    threads.emplace_back([i, &results, &list]() {
      auto t0 = std::chrono::steady_clock::now();
      std::string greeting, err;
      bool ok = proto::probe_greeting(list[i].host, list[i].port, list[i].ssl, 6000, greeting, err);
      auto dt = std::chrono::duration_cast<std::chrono::milliseconds>(
                    std::chrono::steady_clock::now() - t0).count();
      Result& r = results[i];
      r.elapsed_ms = (int)dt;
      if (ok) {
        const std::string& k = r.c.kind;
        bool match = (k == "smtp") ? util::starts_with(greeting, "220")
                     : (k == "pop3") ? util::starts_with(greeting, "+OK")
                                     : util::starts_with(greeting, "* OK");
        r.ok = match;
        r.greeting = greeting;
        if (!match) r.error = "端口通但不是该协议的服务器: " + greeting;
      } else {
        r.error = err;
      }
    });
  }
  for (auto& t : threads) t.join();

  util::Json root = util::Json::make_object();
  root["ok"] = util::Json::make_bool(true);
  util::Json arr = util::Json::make_array();
  for (const auto& r : results) {
    util::Json o = util::Json::make_object();
    o["kind"] = util::Json::make_string(r.c.kind);
    o["host"] = util::Json::make_string(r.c.host);
    o["port"] = util::Json::make_number(r.c.port);
    o["ssl"] = util::Json::make_bool(r.c.ssl);
    o["ok"] = util::Json::make_bool(r.ok);
    o["error"] = util::Json::make_string(r.error);
    o["greeting"] = util::Json::make_string(r.greeting);
    o["elapsed_ms"] = util::Json::make_number(r.elapsed_ms);
    arr.arr.push_back(o);
  }
  root["results"] = arr;
  return root.dump();
}

} // namespace

std::string App::api_test() {
  proto::SmtpConfig sc;
  proto::ImapConfig ic;
  proto::Pop3Config pc;
  std::string mode, email, pass;
  {
    std::lock_guard lk(mtx);
    sc = store.account.smtp;
    ic = store.account.imap;
    pc = store.account.pop3;
    mode = store.account.mode;
    email = store.account.email;
    pass = store.account.password;
  }
  sc.user = email;
  sc.pass = pass;
  sc.from_addr = email;
  sc.display_name = store.account.display_name;
  ic.user = email;
  ic.pass = pass;
  pc.user = email;
  pc.pass = pass;

  // 并发测试 SMTP 与收信，避免依次等待两个 15 秒超时而让 UI 长时间无响应
  std::string e1, e2;
  bool o1 = false, o2 = false;
  std::thread t1([&] { o1 = proto::test_smtp(sc, e1); });
  std::thread t2([&] {
    o2 = (mode == "pop3") ? proto::test_pop3(pc, e2) : proto::test_imap(ic, e2);
  });
  t1.join();
  t2.join();

  util::Json root = util::Json::make_object();
  root["ok"] = util::Json::make_bool(o1 && o2);
  util::Json s = util::Json::make_object();
  s["ok"] = util::Json::make_bool(o1);
  s["error"] = util::Json::make_string(e1);
  root["smtp"] = s;
  util::Json r = util::Json::make_object();
  r["ok"] = util::Json::make_bool(o2);
  r["error"] = util::Json::make_string(e2);
  root["recv"] = r;

  // 连接失败时自动附带「哪些服务器能连」的建议，省得用户逐个试
  if (!(o1 && o2)) {
    auto at = email.rfind('@');
    std::string dom;
    if (at != std::string::npos) dom = util::to_lower(email.substr(at + 1));
    std::vector<ProbeCand> list;
    auto_candidates(dom, list);
    if (!list.empty()) {
      util::Json probed = util::Json::parse(probe_candidates_json(list));
      if (const util::Json* arr = probed.get("results")) root["hints"] = *arr;
    }
  }
  return root.dump();
}

std::string App::api_poll() {
  trigger_poll();
  return json_ok();
}

// CSRF / DNS-rebinding 防护。
// 浏览器发出的请求会带 Origin 头；本地工具（curl 等）不带。
// 1) 绑定回环地址时：Host 必须是 127.0.0.1/localhost/[::1] —— 直接阻断 DNS-rebinding
//    （攻击者域名解析到 127.0.0.1 时 Host 是攻击者域名，不在白名单内）。
// 2) 任何情况下：若带 Origin，其 host 必须与 Host 一致 —— 阻断跨站请求
//    （恶意网页 fetch 本机 API 时 Origin 是恶意站点）。
bool App::api_guard(const http::Request& req) const {
  auto host_only = [](std::string h) -> std::string {
    auto cl = h.rfind(':');
    if (cl != std::string::npos) {
      bool numeric = true;
      for (size_t k = cl + 1; k < h.size(); ++k)
        if (!isdigit((unsigned char)h[k])) { numeric = false; break; }
      if (numeric) h = h.substr(0, cl);
    }
    if (h.size() >= 2 && h.front() == '[' && h.back() == ']') h = h.substr(1, h.size() - 2);
    return util::to_lower(h);
  };
  auto is_loopback = [&](const std::string& h) {
    std::string x = host_only(h);
    return x == "127.0.0.1" || x == "localhost" || x == "::1";
  };
  // 绑定回环时严格校验 Host；否则（显式 --host 0.0.0.0 开放局域网）只做 Origin 校验
  if (is_loopback(bind_host_)) {
    if (!is_loopback(req.host)) return false;
  }
  if (!req.origin.empty()) {
    std::string o = req.origin;
    if (o.compare(0, 7, "http://") == 0) o = o.substr(7);
    else if (o.compare(0, 8, "https://") == 0) o = o.substr(8);
    auto slash = o.find('/');
    if (slash != std::string::npos) o = o.substr(0, slash);
    std::string oh = host_only(o);  // Origin 带端口时剥掉端口，与 Host 一致比较
    if (oh == "null") return false; // file:// 或 sandbox iframe
    if (oh != host_only(req.host)) return false;
  }
  return true;
}

// 自动检测服务器：并发探测一组 (kind, host, port, ssl) 候选，返回每个是否可连。
// body 可以是 {"candidates":[{kind,host,port,ssl}, ...]}，
// 或者 {"email":"you@shphschool.com"}（按域名扩展出常见候选）。
std::string App::api_probe(const util::Json& body) {
  std::vector<ProbeCand> list;
  if (const util::Json* ca = body.get("candidates"); ca && ca->is_array()) {
    for (const auto& it : ca->arr) {
      if (!it.is_object()) continue;
      ProbeCand c;
      c.kind = jstr(it, "kind");
      c.port = jint(it, "port", 0);
      c.ssl = jbool(it, "ssl", true);
      c.host = util::normalize_host(jstr(it, "host"), c.port);
      if (!c.host.empty() && c.port > 0) list.push_back(c);
    }
  }
  if (list.empty()) {
    std::string email = jstr(body, "email");
    if (email.empty()) email = store.account.email;
    auto at = email.rfind('@');
    std::string dom;
    if (at != std::string::npos) dom = util::to_lower(email.substr(at + 1));
    if (dom.empty()) return json_err("请先填写邮箱地址（用于自动检测服务器）");
    auto_candidates(dom, list);
  }
  if (list.empty()) return json_err("没有可检测的候选服务器");
  return probe_candidates_json(list);
}

http::Handler App::make_handler() {
  App* self = this;
  return [self](const http::Request& req, http::Response& resp) {
    std::string path = req.path;
    std::string query;
    auto q = path.find('?');
    if (q != std::string::npos) {
      query = path.substr(q + 1);
      path = path.substr(0, q);
    }
    try {
      // 所有 /api/* 请求先过 CSRF / DNS-rebinding 防护
      if (!self->api_guard(req)) {
        resp.set_json(403, json_err("拒绝访问：来源不受信任（Host/Origin 校验未通过）"));
        return;
      }
      if (path == "/api/state" && req.method == "GET") {
        resp.set_json(200, self->api_state());
        return;
      }
      if (path == "/api/messages" && req.method == "GET") {
        resp.set_json(200, self->api_messages(query_param(query, "with")));
        return;
      }
      if (path == "/api/send" && req.method == "POST") {
        util::Json body = util::Json::parse(req.body);
        resp.set_json(200, self->api_send(jstr(body, "to"), jstr(body, "text")));
        return;
      }
      if (path == "/api/read" && req.method == "POST") {
        util::Json body = util::Json::parse(req.body);
        resp.set_json(200, self->api_read(jstr(body, "with")));
        return;
      }
      if (path == "/api/friends" && req.method == "POST") {
        util::Json body = util::Json::parse(req.body);
        resp.set_json(200, self->api_friends(body));
        return;
      }
      if (path == "/api/config" && req.method == "POST") {
        util::Json body = util::Json::parse(req.body);
        resp.set_json(200, self->api_config(body));
        return;
      }
      if (path == "/api/test" && req.method == "POST") {
        resp.set_json(200, self->api_test());
        return;
      }
      if (path == "/api/probe" && req.method == "POST") {
        util::Json body = util::Json::parse(req.body);
        resp.set_json(200, self->api_probe(body));
        return;
      }
      if (path == "/api/poll" && req.method == "POST") {
        resp.set_json(200, self->api_poll());
        return;
      }
      resp.set_text(404, "unknown api");
    } catch (const std::exception& e) {
      resp.set_json(500, json_err(std::string("内部错误: ") + e.what()));
    }
  };
}

} // namespace app