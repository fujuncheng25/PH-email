#include "app.hpp"

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <random>
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
  std::ifstream f(path, std::ios::binary);
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

bool read_bytes(const std::string& path, std::string& out) {
  std::ifstream f(path, std::ios::binary);
  if (!f) return false;
  std::ostringstream ss;
  ss << f.rdbuf();
  out = ss.str();
  return true;
}

std::string jstr(const util::Json& o, const char* k, const std::string& def = "") {
  const util::Json* v = o.get(k);
  return v ? v->as_string(def) : def;
}
int jint(const util::Json& o, const char* k, int def) {
  const util::Json* v = o.get(k);
  return v ? (int)v->as_int64(def) : def;
}
int64_t jint64(const util::Json& o, const char* k, int64_t def) {
  const util::Json* v = o.get(k);
  return v ? v->as_int64(def) : def;
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

std::string random_hex(size_t n) {
  // thread_local：/api/upload 等会被多个 HTTP 连接线程并发调用，静态 rng 有数据竞争
  static thread_local std::mt19937_64 rng{std::random_device{}()};
  static const char* hexd = "0123456789abcdef";
  std::string out;
  for (size_t i = 0; i < n; ++i) out += hexd[rng() & 15];
  return out;
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

// /api/state 顶层 ai、/api/ai/status 的 ai 对象（FEATURE-SPEC §4.6）
util::Json json_ai_status(const ai::Status& st) {
  util::Json j = util::Json::make_object();
  j["enabled"] = util::Json::make_bool(st.enabled);
  j["model_ready"] = util::Json::make_bool(st.model_ready);
  j["downloading"] = util::Json::make_bool(st.downloading);
  j["downloaded_bytes"] = util::Json::make_number((double)st.downloaded_bytes);
  j["total_bytes"] = util::Json::make_number((double)st.total_bytes);
  int percent = 0;
  if (st.total_bytes > 0) {
    long long p = st.downloaded_bytes * 100 / st.total_bytes;
    if (p < 0) p = 0;
    if (p > 100) p = 100;
    percent = (int)p;
  } else if (st.model_ready) {
    percent = 100;
  }
  j["percent"] = util::Json::make_number(percent);
  j["error"] = util::Json::make_string(st.error);
  j["model_file"] = util::Json::make_string(
      st.model_file.empty() ? "qwen2.5-0.5b-instruct-q4_k_m.gguf" : st.model_file);
  j["mirror"] = util::Json::make_string(st.mirror.empty() ? "https://hf-mirror.com" : st.mirror);
  j["busy"] = util::Json::make_bool(st.busy);
  j["engine"] = util::Json::make_string(
      st.engine.empty() ? "qwen2.5-0.5b-instruct-q4_k_m" : st.engine);
  return j;
}

// 消息附件 → /api/messages 里的对象（§2：含 url/inline）
util::Json attachment_json(const mime::Attachment& a) {
  util::Json o = util::Json::make_object();
  o["name"] = util::Json::make_string(a.name);
  o["mime"] = util::Json::make_string(a.mime.empty() ? "application/octet-stream" : a.mime);
  o["size"] = util::Json::make_number((double)a.size);
  o["file"] = util::Json::make_string(a.file);
  o["url"] = util::Json::make_string(a.file.empty()
                                         ? ""
                                         : "/api/attachment?file=" + util::url_encode_component(a.file));
  o["inline"] = util::Json::make_bool(a.inline_);
  return o;
}

// 收件人列表解析：逗号/分号/空白分隔，去空、去重、必须含 @，每类最多 max_count 个。
void parse_addr_list(const std::string& raw, size_t max_count, std::vector<std::string>& out) {
  const size_t start = out.size();
  std::string cur;
  auto flush = [&]() {
    std::string e = util::to_lower(util::trim(cur));
    cur.clear();
    if (e.empty()) return;
    if (out.size() - start >= max_count) return;
    if (e.size() >= 2 && e.front() == '<' && e.back() == '>') e = e.substr(1, e.size() - 2);
    if (e.find('@') == std::string::npos) return;
    for (const auto& x : out) {
      if (x == e) return;
    }
    out.push_back(e);
  };
  for (char c : raw) {
    if (c == ',' || c == ';' || c == ' ' || c == '\t' || c == '\r' || c == '\n') flush();
    else cur += c;
  }
  flush();
}

// data/attachments 下文件名的安全分量：只保留 [A-Za-z0-9._-] 与中文，去路径分隔符；
// 截断到 60 字符时保留扩展名（避免长文件名把 .png 切掉导致 Content-Type 错误）。
std::string sanitize_stored_component(const std::string& name) {
  std::string out;
  for (unsigned char c : util::trim(name)) {
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '.' ||
        c == '_' || c == '-' || c >= 0x80) {
      out += (char)c;
    } else {
      out += '_';
    }
  }
  while (!out.empty() && out.front() == '.') out.erase(out.begin());
  if (out.empty()) out = "file";
  constexpr size_t kMaxChars = 60;
  if (util::utf8_chars(out) <= kMaxChars) return out;
  // 拆出扩展名（最多 12 字节，且不能是纯 "."），只截断主名，最后补回扩展名
  std::string ext;
  auto dot = out.rfind('.');
  if (dot != std::string::npos && dot > 0 && out.size() - dot <= 12) ext = out.substr(dot);
  const size_t ext_chars = util::utf8_chars(ext);
  const size_t stem_max = kMaxChars > ext_chars ? kMaxChars - ext_chars : 1;
  std::string stem = ext.empty() ? out : out.substr(0, out.size() - ext.size());
  stem = util::truncate_utf8_chars(stem, stem_max);
  if (stem.empty()) stem = "file";
  return stem + ext;
}

// 把附件字节写入 data/attachments/，生成 <epoch>-<4hex>-<sanitized-name>（重名追加序号）。
bool write_attachment_file(const std::string& dir, const std::string& original,
                           const std::string& data, std::string& out_file) {
  if (!ensure_dir(dir)) return false;
  const std::string safe = sanitize_stored_component(original);
  const std::string base = std::to_string(util::now_epoch()) + "-" + random_hex(4) + "-" + safe;
  std::string name = base;
  int n = 1;
  while (file_exists(dir + "/" + name)) name = base + "-" + std::to_string(n++);
  if (!write_file(dir + "/" + name, data)) return false;
  out_file = name;
  return true;
}

std::string base_mime(const std::string& mime) {
  std::string m = util::to_lower(util::trim(mime));
  auto semi = m.find(';');
  if (semi != std::string::npos) m = util::trim(m.substr(0, semi));
  if (m.empty() || m.find('/') == std::string::npos) return "application/octet-stream";
  return m;
}

std::string join_addrs(const std::vector<std::string>& list) {
  std::string out;
  for (size_t i = 0; i < list.size(); ++i) {
    if (i) out += ", ";
    out += list[i];
  }
  return out;
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
  pending_recalls.clear();
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

    if (const util::Json* ai_cfg = cfg.get("ai"); ai_cfg && ai_cfg->is_object()) {
      account.ai.enabled = jbool(*ai_cfg, "enabled", false);
      std::string mirror = util::trim(jstr(*ai_cfg, "mirror"));
      account.ai.mirror = mirror.empty() ? "https://hf-mirror.com" : mirror;
      account.ai.model_url = util::sanitize_header(util::trim(jstr(*ai_cfg, "model_url")));
      std::string mf = mime::sanitize_filename(util::trim(jstr(*ai_cfg, "model_file")), 120);
      account.ai.model_file = (mf.empty() || mf == "file") ? "qwen2.5-0.5b-instruct-q4_k_m.gguf" : mf;
    }

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
    if (const util::Json* pr = cfg.get("pending_recalls"); pr && pr->is_array()) {
      for (const auto& item : pr->arr) {
        std::string mid = util::trim(item.as_string());
        if (!mid.empty()) pending_recalls.insert(mid);
      }
    }
    if (const util::Json* un = cfg.get("unread"); un && un->is_object()) {
      for (const auto& kv : un->obj) unread[kv.first] = (int)kv.second.as_int64(0);
    }
    next_msg_id = jint64(cfg, "next_msg_id", 1);
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
          m.id = jint64(item, "id", 0);
          m.dir = jstr(item, "dir");
          m.kind = util::to_lower(util::trim(jstr(item, "kind", "chat")));
          if (m.kind != "email") m.kind = "chat";
          m.text = jstr(item, "text");
          m.subject = jstr(item, "subject");
          m.ts = jint64(item, "ts", 0);
          m.mid = jstr(item, "mid");
          m.uid = jstr(item, "uid");
          m.recalled = jbool(item, "recalled", false);
          if (const util::Json* q = item.get("quote"); q && q->is_object()) {
            m.has_quote = true;
            m.quote.text = util::truncate_utf8_chars(jstr(*q, "text"), 500);
            m.quote.from = jstr(*q, "from");
            m.quote.ts = jint64(*q, "ts", 0);
            m.quote.mid = jstr(*q, "mid");
          }
          if (const util::Json* at = item.get("attachments"); at && at->is_array()) {
            for (const auto& ai : at->arr) {
              if (!ai.is_object()) continue;
              mime::Attachment a;
              a.name = jstr(ai, "name");
              a.mime = jstr(ai, "mime", "application/octet-stream");
              a.size = jint64(ai, "size", 0);
              a.file = jstr(ai, "file");
              a.inline_ = jbool(ai, "inline", mime::is_image_mime(a.mime));
              m.attachments.push_back(a);
            }
          }
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

  util::Json aic = util::Json::make_object();
  aic["enabled"] = util::Json::make_bool(account.ai.enabled);
  aic["mirror"] = util::Json::make_string(account.ai.mirror.empty() ? "https://hf-mirror.com"
                                                                    : account.ai.mirror);
  aic["model_url"] = util::Json::make_string(account.ai.model_url);
  aic["model_file"] = util::Json::make_string(account.ai.model_file.empty()
                                                  ? "qwen2.5-0.5b-instruct-q4_k_m.gguf"
                                                  : account.ai.model_file);
  cfg["ai"] = aic;

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

  util::Json pr = util::Json::make_array();
  for (const auto& k : pending_recalls) pr.arr.push_back(util::Json::make_string(k));
  cfg["pending_recalls"] = pr;

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
      item["kind"] = util::Json::make_string(m.kind.empty() ? "chat" : m.kind);
      item["text"] = util::Json::make_string(m.text);
      if (!m.subject.empty()) item["subject"] = util::Json::make_string(m.subject);
      item["ts"] = util::Json::make_number((double)m.ts);
      if (!m.mid.empty()) item["mid"] = util::Json::make_string(m.mid);
      if (!m.uid.empty()) item["uid"] = util::Json::make_string(m.uid);
      if (m.recalled) item["recalled"] = util::Json::make_bool(true);
      if (m.has_quote) {
        util::Json q = util::Json::make_object();
        q["text"] = util::Json::make_string(m.quote.text);
        q["from"] = util::Json::make_string(m.quote.from);
        q["ts"] = util::Json::make_number((double)m.quote.ts);
        q["mid"] = util::Json::make_string(m.quote.mid);
        item["quote"] = q;
      }
      if (!m.attachments.empty()) {
        util::Json ats = util::Json::make_array();
        for (const auto& a : m.attachments) {
          util::Json o = util::Json::make_object();
          o["name"] = util::Json::make_string(a.name);
          o["mime"] = util::Json::make_string(a.mime);
          o["size"] = util::Json::make_number((double)a.size);
          o["file"] = util::Json::make_string(a.file);
          o["inline"] = util::Json::make_bool(a.inline_);
          ats.arr.push_back(o);
        }
        item["attachments"] = ats;
      }
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

bool Store::add_message(const std::string& peer, Message m, int64_t* out_id) {
  // 收件按 Message-ID 去重：POP3 的 seen 表清空/损坏/换机重拉时，
  // 同一封邮件（同 Message-ID）不应在对话里出现两次。
  if (m.dir == "in" && !m.mid.empty()) {
    auto& conv = conversations[peer];
    for (const auto& x : conv) {
      if (x.dir == "in" && !x.mid.empty() && x.mid == m.mid) return false;
    }
    // 已被撤回：今后收到该 mid 的来信直接丢弃（FEATURE-SPEC §4.4）
    if (pending_recalls.count(m.mid) != 0) return false;
  }
  m.kind = (m.kind == "email") ? "email" : "chat";
  const size_t max_chars = (m.kind == "email") ? 16000 : 4000;
  std::string t = util::trim(m.text);
  if (!t.empty()) t = util::truncate_utf8_chars(t, max_chars);
  // 附件/引用消息允许正文为空（不要用 "(空消息)" 覆盖附件消息）
  if (t.empty() && m.attachments.empty() && !m.has_quote) t = "(空消息)";
  m.text = t;
  m.id = next_msg_id++;
  if (m.ts <= 0) m.ts = util::now_epoch();
  auto& conv = conversations[peer];
  conv.push_back(std::move(m));
  if (out_id) *out_id = conv.back().id;
  if (conv.size() > 300) conv.erase(conv.begin(), conv.begin() + (long)(conv.size() - 300));
  return true;
}

bool Store::add_message(const std::string& peer, const std::string& dir, const std::string& text,
                        int64_t ts, const std::string& mid, const std::string& kind) {
  Message m;
  m.dir = dir;
  m.text = text;
  m.ts = ts;
  m.mid = mid;
  m.kind = kind;
  return add_message(peer, std::move(m), nullptr);
}

void Store::mark_read(const std::string& peer) { unread.erase(peer); }

std::string Store::last_text(const std::string& peer) const {
  auto it = conversations.find(peer);
  if (it == conversations.end() || it->second.empty()) return "";
  const Message& m = it->second.back();
  if (m.recalled) return "[已撤回]";
  bool has_image = false, has_other = false;
  std::string other_name;
  for (const auto& a : m.attachments) {
    if (a.inline_) {
      has_image = true;
    } else {
      has_other = true;
      if (other_name.empty()) other_name = a.name;
    }
  }
  if (has_image) return "[图片]";
  if (has_other) return "[文件] " + other_name;
  if (m.kind == "email" && !m.subject.empty()) return m.subject;
  std::string first = m.text;
  auto nl = first.find('\n');
  if (nl != std::string::npos) first = first.substr(0, nl);
  first = util::trim(first);
  if (!first.empty()) return first;
  return util::trim(m.text);
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
  // 启动时创建附件/上传/模型目录，并清理超 24h 的暂存上传
  ensure_dir(data_dir + "/attachments");
  ensure_dir(data_dir + "/uploads");
  ensure_dir(data_dir + "/models");
  cleanup_uploads();
  ai::manager().init(data_dir);
  ai::manager().set_config(store.account.ai);

  std::string herr;
  if (!http::listen(bind_host, port, listen_fd, port_, herr)) {
    err = herr;
    return false;
  }
  return true;
}

void App::cleanup_uploads() {
  const std::string dir = store.data_dir + "/uploads";
  std::error_code ec;
  std::filesystem::create_directories(dir, ec);
  auto now = std::filesystem::file_time_type::clock::now();
  for (auto it = std::filesystem::directory_iterator(dir, ec);
       !ec && it != std::filesystem::directory_iterator(); it.increment(ec)) {
    std::error_code fec;
    if (!it->is_regular_file(fec)) continue;
    auto ft = it->last_write_time(fec);
    if (fec) continue;
    auto age = std::chrono::duration_cast<std::chrono::seconds>(now - ft).count();
    if (age > 24LL * 3600) std::filesystem::remove(it->path(), fec);
  }
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
    // 空闲 5 分钟后卸载模型内存（FEATURE-SPEC §6.2）
    ai::manager().idle_tick();
  }
}

bool App::poll_once(std::string& err) {
  err.clear();
  proto::ImapConfig ic;
  proto::Pop3Config pc;
  std::string mode, email, pass;
  std::set<std::string> seen_p, seen_i;
  std::set<std::string> pending_seen;
  {
    std::lock_guard lk(mtx);
    ic = store.account.imap;
    pc = store.account.pop3;
    mode = store.account.mode;
    email = store.account.email;
    pass = store.account.password;
    seen_p = store.seen_pop3;
    seen_i = store.seen_imap;
    pending_seen = pending_seen_imap;  // 2.1：打开会话待标已读的 UID
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
    // 2.1：收信用 BODY.PEEK[]（不自动置已读）；只有打开会话收集的 UID 才批量标 \Seen。
    fr = proto::imap_fetch(ic, seen_i, 300, pending_seen);
    // 成功标记的 uid 从 pending 移除；失败的保留，下次轮询重试。
    if (!fr.seen_marked.empty()) {
      std::lock_guard lk(mtx);
      for (const auto& u : fr.seen_marked) pending_seen_imap.erase(u);
    }
  }

  int fetched = 0, skipped = 0;
  if (fr.ok) {
    bool seen_changed = false;
    bool recall_state_changed = false;    // 有消息被置为撤回（写 messages.json）
    bool pending_recalls_changed = false; // 新增 pending_recalls（写 config.json）
    const std::string att_dir = store.data_dir + "/attachments";

    struct Pending {
      std::string peer;
      std::vector<mime::Attachment> atts;  // 从 fr.messages 移出，避免整封 raw 复制
      Message msg;
    };
    std::vector<Pending> pending;

    // 第一阶段（持锁）：过滤白名单、处理撤回通知、按 mid 去重预检
    {
      std::lock_guard lk(mtx);
      for (auto& m : fr.messages) {
        if (m.from_addr.empty() || m.from_addr == email) { skipped++; continue; }
        if (!store.is_friend(m.from_addr)) { skipped++; continue; }
        if (!m.recall_mid.empty() || m.kind == "recall") {
          // 撤回通知：不生成聊天消息
          if (!m.recall_mid.empty()) {
            auto it = store.conversations.find(m.from_addr);
            bool found = false;
            if (it != store.conversations.end()) {
              for (auto& x : it->second) {
                if (x.dir == "in" && !x.mid.empty() && x.mid == m.recall_mid) {
                  found = true;
                  x.recalled = true;  // 不改顺序、不改变未读
                  break;
                }
              }
            }
            if (found) {
              recall_state_changed = true;
            } else if (store.pending_recalls.insert(m.recall_mid).second) {
              pending_recalls_changed = true;
            }
          }
          continue;
        }
        Pending p;
        p.peer = m.from_addr;
        p.msg.dir = "in";
        p.msg.kind = (m.kind == "email") ? "email" : "chat";
        p.msg.text = m.body_text;
        p.msg.subject = util::truncate_utf8_chars(util::sanitize_header(m.subject), 200);
        p.msg.ts = m.date_epoch;
        p.msg.mid = m.message_id;
        p.msg.uid = m.uid;  // 2.1：记录 IMAP UID（POP3 为空）
        if (m.has_quote) {
          p.msg.has_quote = true;
          p.msg.quote = m.quote;
        }
        // 只移动附件数据，不再复制整封 mime::Msg（raw/正文/附件 data 均不重复持有）
        p.atts = std::move(m.attachments);
        m.body_text.clear();
        pending.push_back(std::move(p));
      }
    }

    // 第二阶段（锁外）：附件落盘（大文件写入不阻塞 HTTP API）
    int write_failed = 0;
    for (auto& p : pending) {
      for (auto& a : p.atts) {
        std::string fname;
        if (write_attachment_file(att_dir, a.name, a.data, fname)) {
          a.file = fname;
          a.size = (long long)a.data.size();
          a.data.clear();
          a.data.shrink_to_fit();
          p.msg.attachments.push_back(std::move(a));
        } else {
          write_failed++;
        }
      }
      p.atts.clear();
    }

    // 第三阶段（持锁）：写消息、更新未读与 seen 表
    {
      std::lock_guard lk(mtx);
      for (auto& p : pending) {
        // 先记录已落盘附件名：add_message 返回 false（重复 mid / pending_recalls）时要删掉，
        // 否则这些文件永远不被引用（孤儿文件，磁盘无上限增长）。
        std::vector<std::string> files;
        files.reserve(p.msg.attachments.size());
        for (const auto& a : p.msg.attachments) files.push_back(a.file);
        if (store.add_message(p.peer, std::move(p.msg))) {
          store.unread[p.peer] += 1;
          fetched++;
        } else {
          skipped++;
          for (const auto& f : files) {
            if (!f.empty()) std::remove((att_dir + "/" + f).c_str());
          }
        }
      }
      skipped += write_failed;
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
      if (fetched > 0 || recall_state_changed) store.save_messages(serr);
      // 只在真正有变化时才写配置，避免每 8 秒无条件磁盘写入
      if (seen_changed || fetched > 0 || pending_recalls_changed) store.save_config(serr);
      poll_status.last_ts = util::now_epoch();
      poll_status.ok = true;
      poll_status.error.clear();
      poll_status.fetched = fetched;
      poll_status.skipped = skipped;
    }
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
  const ai::Status ai_st = ai::manager().status();
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
  util::Json aic = util::Json::make_object();
  aic["enabled"] = util::Json::make_bool(store.account.ai.enabled);
  aic["mirror"] = util::Json::make_string(store.account.ai.mirror);
  aic["model_url"] = util::Json::make_string(store.account.ai.model_url);
  aic["model_file"] = util::Json::make_string(store.account.ai.model_file);
  acc["ai"] = aic;
  root["account"] = acc;

  util::Json poll = util::Json::make_object();
  poll["last_ts"] = util::Json::make_number((double)poll_status.last_ts);
  poll["ok"] = util::Json::make_bool(poll_status.ok);
  poll["error"] = util::Json::make_string(poll_status.error);
  poll["fetched"] = util::Json::make_number(poll_status.fetched);
  poll["skipped"] = util::Json::make_number(poll_status.skipped);
  root["poll"] = poll;

  // 顶层 ai 状态对象（§4.6）
  root["ai"] = json_ai_status(ai_st);

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
      item["kind"] = util::Json::make_string(m.kind.empty() ? "chat" : m.kind);
      item["text"] = util::Json::make_string(m.text);
      if (!m.subject.empty()) item["subject"] = util::Json::make_string(m.subject);
      item["ts"] = util::Json::make_number((double)m.ts);
      item["time"] = util::Json::make_string(util::format_local(m.ts));
      if (!m.mid.empty()) item["mid"] = util::Json::make_string(m.mid);
      if (!m.uid.empty()) item["uid"] = util::Json::make_string(m.uid);
      item["recalled"] = util::Json::make_bool(m.recalled);
      if (m.has_quote) {
        util::Json q = util::Json::make_object();
        q["text"] = util::Json::make_string(m.quote.text);
        q["from"] = util::Json::make_string(m.quote.from);
        q["ts"] = util::Json::make_number((double)m.quote.ts);
        q["mid"] = util::Json::make_string(m.quote.mid);
        item["quote"] = q;
      }
      if (!m.attachments.empty()) {
        util::Json ats = util::Json::make_array();
        for (const auto& a : m.attachments) ats.arr.push_back(attachment_json(a));
        item["attachments"] = ats;
      }
      arr.arr.push_back(item);
    }
  }
  root["messages"] = arr;
  return root.dump();
}

std::string App::api_send(const util::Json& body) {
  const std::string peer = util::to_lower(util::trim(jstr(body, "to")));
  std::string text = util::trim(jstr(body, "text"));
  std::string kind = util::to_lower(util::trim(jstr(body, "kind", "chat")));
  if (kind != "email") kind = "chat";
  std::string user_subject =
      util::truncate_utf8_chars(util::sanitize_header(util::trim(jstr(body, "subject"))), 200);
  const std::string cc_raw = jstr(body, "cc");
  const std::string bcc_raw = jstr(body, "bcc");

  // 引用（后端截断到 500 字符）
  bool has_quote = false;
  mime::Quote quote;
  if (const util::Json* q = body.get("quote"); q && q->is_object()) {
    quote.text = util::replace_all(util::truncate_utf8_chars(jstr(*q, "text"), 500), "\r", "");
    quote.from = util::sanitize_header(util::trim(jstr(*q, "from")));
    quote.ts = jint64(*q, "ts", 0);
    quote.mid = util::sanitize_header(util::trim(jstr(*q, "mid")));
    has_quote = !quote.text.empty() || !quote.mid.empty();
  }

  // 暂存附件（从 data/uploads/ 取）
  std::vector<Upload> ups;
  if (const util::Json* at = body.get("attachments"); at && at->is_array()) {
    std::lock_guard lk(upload_mtx);
    for (const auto& it : at->arr) {
      if (!it.is_object()) continue;
      const std::string id = jstr(it, "id");
      auto f = uploads.find(id);
      if (f == uploads.end()) return json_err("附件已失效，请重新添加");
      if (!file_exists(f->second.path)) {
        uploads.erase(f);
        return json_err("附件已失效，请重新添加");
      }
      ups.push_back(f->second);
    }
  }
  long long att_total = 0;
  for (const auto& u : ups) att_total += u.size;
  if (att_total > mime::kMaxAttachmentsTotal) return json_err("附件总大小不能超过 24MB");

  if (peer.empty()) return json_err("收件人不能为空");
  if (text.empty() && ups.empty() && !has_quote) return json_err("内容不能为空");

  // 账户与 SMTP 配置
  proto::SmtpConfig cfg;
  ai::Config aicfg;
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
    cfg.display_name =
        store.account.display_name.empty() ? store.account.email : store.account.display_name;
    aicfg = store.account.ai;
  }
  if (cfg.host.empty()) return json_err("请先在设置中配置 SMTP 服务器");

  // 收件人 = to + cc + bcc（去重、去空、校验含 @，最多各 5 个）
  std::vector<std::string> rcpts;
  std::vector<std::string> cc_list, bcc_list;
  parse_addr_list(peer, 5, rcpts);
  parse_addr_list(cc_raw, 5, cc_list);
  parse_addr_list(bcc_raw, 5, bcc_list);
  for (const auto& c : cc_list) parse_addr_list(c, 1, rcpts);  // 复用去重（已在 out 中的会跳过）
  for (const auto& b : bcc_list) parse_addr_list(b, 1, rcpts);
  if (rcpts.empty()) return json_err("收件人邮箱格式不正确");

  // 正文：email 模式允许无正文但需附件，补 "（无正文）"
  std::string body_text = text;
  if (kind == "email" && body_text.empty() && !ups.empty()) body_text = "（无正文）";

  // 主题
  const ai::Status ai_st = ai::manager().status();
  const bool ai_on = aicfg.enabled && ai_st.model_ready;
  std::string subject;
  bool ai_generated = false;
  if (kind == "chat") {
    subject = "email-chatter 消息";
    if (ai_on) {
      std::string src, note;
      std::string t = ai::manager().generate_title(text, src, note);
      if (src == "ai" && !t.empty()) {
        subject = util::truncate_utf8_chars(util::trim(t), 200);
        ai_generated = true;
      }
    }
  } else {
    if (!user_subject.empty()) {
      subject = user_subject;
    } else {
      std::string t;
      if (ai_on) {
        std::string src, note;
        t = ai::manager().generate_title(text, src, note);
        ai_generated = (src == "ai" && !t.empty());
      }
      if (!ai_generated) t = ai::heuristic_title(text);
      subject = util::truncate_utf8_chars(util::trim(t), 200);
      if (subject.empty()) subject = "无主题";
    }
  }

  // 2.1 引用=reply：quote.mid 合法时主题加 Re:（本地存储记录带 Re: 的实际主题；
  // build_message 内部同样幂等地加 Re: 并写 In-Reply-To/References）。
  if (has_quote && mime::valid_msgid(quote.mid)) {
    subject = mime::with_re_prefix(subject);
  }

  // 读取附件字节（发送失败不落盘、不移动暂存文件）
  mime::ComposeOptions opt;
  for (const auto& u : ups) {
    std::string data;
    if (!read_bytes(u.path, data)) return json_err("读取附件失败，请重新添加");
    if ((long long)data.size() > mime::kMaxAttachmentBytes) {
      return json_err("单个附件不能超过 16MB");
    }
    mime::Attachment a;
    a.name = u.name;
    a.mime = u.mime;
    a.size = (long long)data.size();
    a.inline_ = mime::is_image_mime(u.mime);
    a.data = std::move(data);
    opt.attachments.push_back(std::move(a));
  }

  opt.from_display = cfg.display_name;
  opt.from_addr = cfg.from_addr;
  opt.to_addr = peer;
  opt.cc = join_addrs(cc_list);
  opt.subject = subject;
  opt.body = body_text;
  opt.kind = kind;
  opt.has_quote = has_quote;
  opt.quote = quote;

  std::string msgid;
  std::string raw = mime::build_message(opt, &msgid);
  std::string err;
  if (!proto::smtp_send_raw(cfg, rcpts, raw, err)) {
    return json_err(err.empty() ? "发送失败" : err);
  }

  // 发送成功：附件落盘到 data/attachments/，写本地 out 消息
  std::vector<mime::Attachment> stored_atts;
  const std::string att_dir = store.data_dir + "/attachments";
  for (const auto& a : opt.attachments) {
    std::string fname;
    if (write_attachment_file(att_dir, a.name, a.data, fname)) {
      mime::Attachment sa = a;
      sa.file = fname;
      sa.data.clear();
      stored_atts.push_back(std::move(sa));
    }
  }

  int64_t new_id = 0;
  {
    std::lock_guard lk(mtx);
    Message m;
    m.dir = "out";
    m.kind = kind;
    m.text = body_text;
    m.subject = subject;
    m.ts = util::now_epoch();
    m.mid = msgid;
    m.has_quote = has_quote;
    m.quote = quote;
    m.attachments = std::move(stored_atts);
    store.add_message(peer, std::move(m), &new_id);
    std::string serr;
    store.save_messages(serr);
  }
  // 暂存文件不在这里删除：/api/upload 的暂存件允许在同一次会话内重复使用
  // （FEATURE-SPEC §4.1 的“清理暂存文件”由启动时 24h 清理 + 发送成功后标记过期实现）。
  // 具体做法：保留 metadata 与文件，直到进程退出或超过 24h；这样前端重试/复用不失效。
  {
    std::lock_guard lk(upload_mtx);
    for (const auto& u : ups) {
      auto it = uploads.find(u.id);
      if (it != uploads.end()) it->second.consumed = true;
    }
  }

  util::Json r = util::Json::make_object();
  r["ok"] = util::Json::make_bool(true);
  r["id"] = util::Json::make_number((double)new_id);
  r["subject"] = util::Json::make_string(subject);
  r["ai"] = util::Json::make_bool(ai_generated);
  return r.dump();
}

std::string App::api_send(const std::string& to, const std::string& text) {
  util::Json body = util::Json::make_object();
  body["to"] = util::Json::make_string(to);
  body["text"] = util::Json::make_string(text);
  return api_send(body);
}

std::string App::api_upload(const std::string& name, const std::string& data) {
  if ((long long)data.size() > mime::kMaxAttachmentBytes) return json_err("附件不能超过 16MB");
  const std::string clean_name = mime::sanitize_filename(name.empty() ? "file.bin" : name, 120);
  const std::string id = "u_" + std::to_string(util::now_epoch()) + "_" + random_hex(8);
  const std::string dir = store.data_dir + "/uploads";
  const std::string path = dir + "/" + id;
  if (!ensure_dir(dir) || !write_file(path, data)) return json_err("保存上传文件失败");
  Upload u;
  u.id = id;
  u.name = clean_name;
  u.mime = base_mime(http::content_type_for(clean_name));
  u.size = (long long)data.size();
  u.path = path;
  {
    std::lock_guard lk(upload_mtx);
    uploads[id] = u;
    // 顺手清理已消费的旧暂存（避免长时间运行内存/磁盘累积）
    if (uploads.size() > 200) {
      for (auto it = uploads.begin(); it != uploads.end();) {
        if (it->second.consumed && it->first != id) {
          std::remove(it->second.path.c_str());
          it = uploads.erase(it);
        } else {
          ++it;
        }
      }
    }
  }
  util::Json r = util::Json::make_object();
  r["ok"] = util::Json::make_bool(true);
  r["id"] = util::Json::make_string(id);
  r["name"] = util::Json::make_string(u.name);
  r["size"] = util::Json::make_number((double)u.size);
  r["mime"] = util::Json::make_string(u.mime);
  return r.dump();
}

bool App::serve_attachment(const std::string& file, http::Response& resp) {
  // 只允许 data/attachments/<basename>；basename 不得含 / \ .. 或盘符
  if (file.empty() || file.find('/') != std::string::npos || file.find('\\') != std::string::npos ||
      file.find("..") != std::string::npos || file.find(':') != std::string::npos) {
    resp.set_json(404, json_err("附件不存在"));
    return false;
  }
  std::string data;
  if (!read_bytes(store.data_dir + "/attachments/" + file, data)) {
    resp.set_json(404, json_err("附件不存在"));
    return false;
  }
  const std::string ct = http::content_type_for(file);
  resp.set_bytes(200, ct, std::move(data));
  if (mime::is_image_mime(ct)) {
    resp.set_header("Content-Disposition", "inline");
  } else {
    resp.set_header("Content-Disposition",
                    "attachment; filename*=UTF-8''" + util::url_encode_component(file));
  }
  return true;
}

std::string App::api_recall(const util::Json& body) {
  const std::string peer = util::to_lower(util::trim(jstr(body, "with")));
  const int64_t id = jint64(body, "id", 0);
  std::string mid;
  proto::SmtpConfig cfg;
  {
    std::lock_guard lk(mtx);
    if (!store.is_friend(peer)) return json_err("对方不在好友白名单中，无法撤回");
    auto it = store.conversations.find(peer);
    if (it != store.conversations.end()) {
      for (const auto& m : it->second) {
        if (m.id == id && m.dir == "out" && !m.recalled && !m.mid.empty()) {
          mid = m.mid;
          break;
        }
      }
    }
    if (mid.empty()) return json_err("该消息不支持撤回（缺少邮件标识或已撤回）");
    if (store.account.email.empty() || store.account.password.empty()) {
      return json_err("请先在设置中填写邮箱账户与客户端授权密码");
    }
    cfg.host = store.account.smtp.host;
    cfg.port = store.account.smtp.port;
    cfg.ssl = store.account.smtp.ssl;
    cfg.user = store.account.email;
    cfg.pass = store.account.password;
    cfg.from_addr = store.account.email;
    cfg.display_name =
        store.account.display_name.empty() ? store.account.email : store.account.display_name;
  }
  if (cfg.host.empty()) return json_err("请先在设置中配置 SMTP 服务器");

  // 组装撤回通知邮件（§3.1）：Subject: 撤回了一条消息，Kind: recall，X-Email-Chatter-Recall
  mime::ComposeOptions opt;
  opt.from_display = cfg.display_name;
  opt.from_addr = cfg.from_addr;
  opt.to_addr = peer;
  opt.subject = "撤回了一条消息";
  opt.body = "对方撤回了一条消息";
  opt.kind = "recall";
  opt.recall_mid = mid;
  std::string raw = mime::build_message(opt);
  std::string err;
  if (!proto::smtp_send_raw(cfg, std::vector<std::string>{peer}, raw, err)) {
    return json_err(err.empty() ? "撤回通知发送失败" : err);
  }

  {
    std::lock_guard lk(mtx);
    auto it = store.conversations.find(peer);
    if (it != store.conversations.end()) {
      for (auto& m : it->second) {
        if (m.id == id) {
          m.recalled = true;
          break;
        }
      }
    }
    std::string serr;
    store.save_messages(serr);
  }
  return json_ok();
}

std::string App::api_read(const std::string& peer) {
  {
    std::lock_guard lk(mtx);
    const std::string p = util::to_lower(util::trim(peer));
    store.mark_read(p);
    // 2.1：打开会话 = 标记邮箱已读。收集该会话 dir=in 的 IMAP UID 到 pending，
    // 由下一次轮询批量 UID STORE +FLAGS.SILENT (\Seen)（失败保留重试）。
    auto it = store.conversations.find(p);
    if (it != store.conversations.end()) {
      for (const auto& m : it->second) {
        if (m.dir == "in" && !m.uid.empty()) pending_seen_imap.insert(m.uid);
      }
    }
    std::string err;
    store.save_config(err);
  }
  trigger_poll();  // 不阻塞 HTTP 响应；由 poller 稍后完成服务器端标记
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
  ai::Config new_ai;
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
    // ai 对象：只覆盖提供的字段（§2.1）
    if (const util::Json* a = body.get("ai"); a && a->is_object()) {
      if (a->has("enabled")) store.account.ai.enabled = jbool(*a, "enabled", store.account.ai.enabled);
      if (a->has("mirror")) {
        std::string mirror = util::sanitize_header(util::trim(jstr(*a, "mirror")));
        store.account.ai.mirror = mirror.empty() ? "https://hf-mirror.com" : mirror;
      }
      if (a->has("model_url")) {
        store.account.ai.model_url =
            util::sanitize_header(util::trim(jstr(*a, "model_url")));
      }
      if (a->has("model_file")) {
        std::string mf = mime::sanitize_filename(util::trim(jstr(*a, "model_file")), 120);
        if (!mf.empty() && mf != "file") store.account.ai.model_file = mf;
      }
    }
    new_ai = store.account.ai;
    std::string err;
    if (!store.save_config(err)) return json_err(err);
  }
  ai::manager().set_config(new_ai);
  trigger_poll();
  // 与 Node 后端对齐：返回 ok + 最新 ai 状态对象（保持 ok 字段语义不变）
  util::Json resp = util::Json::make_object();
  resp["ok"] = util::Json::make_bool(true);
  resp["ai"] = json_ai_status(ai::manager().status());
  return resp.dump();
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

std::string App::api_ai_status() {
  util::Json r = util::Json::make_object();
  r["ok"] = util::Json::make_bool(true);
  r["ai"] = json_ai_status(ai::manager().status());
  return r.dump();
}

std::string App::api_ai_download() {
  util::Json r = util::Json::make_object();
  const ai::Status before = ai::manager().status();
  if (before.model_ready) {
    r["ok"] = util::Json::make_bool(true);
    r["already"] = util::Json::make_bool(true);
    r["ai"] = json_ai_status(before);
    return r.dump();
  }
  std::string err;
  const bool started = ai::manager().start_download(err);
  const ai::Status st = ai::manager().status();
  if (!started) {
    if (st.downloading) {
      // 已有下载在进行：视为成功（幂等）
      r["ok"] = util::Json::make_bool(true);
      r["ai"] = json_ai_status(st);
      return r.dump();
    }
    r["ok"] = util::Json::make_bool(false);
    r["error"] = util::Json::make_string(err.empty() ? "无法开始下载" : err);
    r["ai"] = json_ai_status(st);
    return r.dump();
  }
  r["ok"] = util::Json::make_bool(true);
  r["ai"] = json_ai_status(st);
  return r.dump();
}

std::string App::api_ai_cancel() {
  ai::manager().cancel_download();
  util::Json r = util::Json::make_object();
  r["ok"] = util::Json::make_bool(true);
  r["ai"] = json_ai_status(ai::manager().status());
  return r.dump();
}

std::string App::api_ai_title(const util::Json& body) {
  const std::string text = jstr(body, "text");
  util::Json r = util::Json::make_object();
  std::string title, source, note;
  if (util::trim(text).empty()) {
    title = ai::heuristic_title(text);
    source = "heuristic";
  } else {
    title = ai::manager().generate_title(text, source, note);
    if (title.empty()) {
      title = ai::heuristic_title(text);
      source = "heuristic";
    }
    if (source.empty()) source = "heuristic";
  }
  r["ok"] = util::Json::make_bool(true);
  r["subject"] = util::Json::make_string(title);
  r["source"] = util::Json::make_string(source);
  if (source != "ai" && !note.empty()) r["note"] = util::Json::make_string(note);
  return r.dump();
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
      // POST 的 JSON body 统一校验：解析失败/非对象（如 '['*60000 深度炸弹、随机串）
      // 直接返回 400，不进入业务逻辑（避免被当成空对象静默成功）。
      // 空 body 视为 {}（兼容旧调用约定）。
      auto parse_body = [&req, &resp](util::Json& out) -> bool {
        out = util::Json::parse(req.body);
        if (out.is_object()) return true;
        if (util::trim(req.body).empty() || util::trim(req.body) == "null") {
          out = util::Json::make_object();
          return true;
        }
        resp.set_json(400, json_err("请求体不是合法 JSON 对象"));
        return false;
      };
      if (path == "/api/state" && req.method == "GET") {
        resp.set_json(200, self->api_state());
        return;
      }
      if (path == "/api/messages" && req.method == "GET") {
        resp.set_json(200, self->api_messages(query_param(query, "with")));
        return;
      }
      if (path == "/api/send" && req.method == "POST") {
        util::Json body;
        if (!parse_body(body)) return;
        resp.set_json(200, self->api_send(body));
        return;
      }
      if (path == "/api/upload" && req.method == "POST") {
        resp.set_json(200, self->api_upload(query_param(query, "name"), req.body));
        return;
      }
      if (path == "/api/attachment" && (req.method == "GET" || req.method == "HEAD")) {
        self->serve_attachment(query_param(query, "file"), resp);
        return;
      }
      if (path == "/api/recall" && req.method == "POST") {
        util::Json body;
        if (!parse_body(body)) return;
        resp.set_json(200, self->api_recall(body));
        return;
      }
      if (path == "/api/read" && req.method == "POST") {
        util::Json body;
        if (!parse_body(body)) return;
        resp.set_json(200, self->api_read(jstr(body, "with")));
        return;
      }
      if (path == "/api/friends" && req.method == "POST") {
        util::Json body;
        if (!parse_body(body)) return;
        resp.set_json(200, self->api_friends(body));
        return;
      }
      if (path == "/api/config" && req.method == "POST") {
        util::Json body;
        if (!parse_body(body)) return;
        resp.set_json(200, self->api_config(body));
        return;
      }
      if (path == "/api/test" && req.method == "POST") {
        resp.set_json(200, self->api_test());
        return;
      }
      if (path == "/api/probe" && req.method == "POST") {
        util::Json body;
        if (!parse_body(body)) return;
        resp.set_json(200, self->api_probe(body));
        return;
      }
      if (path == "/api/poll" && req.method == "POST") {
        resp.set_json(200, self->api_poll());
        return;
      }
      if (path == "/api/ai/status" && req.method == "GET") {
        resp.set_json(200, self->api_ai_status());
        return;
      }
      if (path == "/api/ai/download" && req.method == "POST") {
        util::Json body;
        if (!parse_body(body)) return;
        resp.set_json(200, self->api_ai_download());
        return;
      }
      if (path == "/api/ai/cancel" && req.method == "POST") {
        util::Json body;
        if (!parse_body(body)) return;
        resp.set_json(200, self->api_ai_cancel());
        return;
      }
      if (path == "/api/ai/title" && req.method == "POST") {
        util::Json body;
        if (!parse_body(body)) return;
        resp.set_json(200, self->api_ai_title(body));
        return;
      }
      resp.set_text(404, "unknown api");
    } catch (const std::exception& e) {
      resp.set_json(500, json_err(std::string("内部错误: ") + e.what()));
    }
  };
}

} // namespace app
