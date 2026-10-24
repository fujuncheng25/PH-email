#include "mime.hpp"

#include <atomic>
#include <cctype>
#include <chrono>
#include <cstdlib>
#include <cstring>
#include <map>
#include <random>
#include <string>
#include <vector>

#include "util.hpp"

namespace mime {

namespace {

struct Headers {
  std::map<std::string, std::string> m;
  bool has(const std::string& k) const { return m.count(k) != 0; }
  std::string get(const std::string& k, const std::string& def = "") const {
    auto it = m.find(k);
    return it == m.end() ? def : it->second;
  }
};

void parse_headers(const std::string& raw_headers, Headers& out) {
  std::vector<std::string> lines;
  size_t i = 0;
  while (i < raw_headers.size()) {
    size_t e = raw_headers.find('\n', i);
    if (e == std::string::npos) e = raw_headers.size();
    std::string line = raw_headers.substr(i, e - i);
    if (!line.empty() && line.back() == '\r') line.pop_back();
    if (!line.empty() && (line[0] == ' ' || line[0] == '\t') && !lines.empty()) {
      lines.back() += " " + util::trim(line);
    } else {
      lines.push_back(line);
    }
    i = e + 1;
  }
  for (const auto& line : lines) {
    auto pos = line.find(':');
    if (pos == std::string::npos) continue;
    std::string name = util::to_lower(util::trim(line.substr(0, pos)));
    std::string val = util::trim(line.substr(pos + 1));
    if (!name.empty() && out.m.find(name) == out.m.end()) out.m[name] = val;
  }
}

struct ContentType {
  std::string type = "text/plain";
  std::map<std::string, std::string> params;
};

ContentType parse_content_type(const std::string& v) {
  ContentType ct;
  std::string s = v;
  auto semi = s.find(';');
  ct.type = util::to_lower(util::trim(s.substr(0, semi)));
  if (ct.type.empty()) ct.type = "text/plain";
  size_t pos = (semi == std::string::npos) ? s.size() : semi + 1;
  while (pos < s.size()) {
    while (pos < s.size() && (s[pos] == ' ' || s[pos] == '\t' || s[pos] == ';')) ++pos;
    size_t eq = s.find('=', pos);
    if (eq == std::string::npos) break;
    std::string name = util::to_lower(util::trim(s.substr(pos, eq - pos)));
    pos = eq + 1;
    std::string val;
    if (pos < s.size() && s[pos] == '"') {
      ++pos;
      while (pos < s.size() && s[pos] != '"') { val += s[pos]; ++pos; }
      if (pos < s.size()) ++pos;
      size_t next = s.find(';', pos);
      pos = (next == std::string::npos) ? s.size() : next + 1;
    } else {
      size_t next = s.find(';', pos);
      val = util::trim(s.substr(pos, next == std::string::npos ? std::string::npos : next - pos));
      pos = (next == std::string::npos) ? s.size() : next + 1;
    }
    if (!name.empty()) ct.params[name] = val;
  }
  return ct;
}

std::vector<std::string> split_multipart(const std::string& body, const std::string& boundary) {
  std::vector<std::string> parts;
  const std::string delim = "--" + boundary;
  size_t pos = 0;
  while (true) {
    size_t b = body.find(delim, pos);
    if (b == std::string::npos) break;
    size_t after = b + delim.size();
    // closing delimiter "--boundary--"?
    if (after + 1 < body.size() && body[after] == '-' && body[after + 1] == '-') break;
    size_t line_end = body.find('\n', after);
    if (line_end == std::string::npos) break;
    size_t part_start = line_end + 1;
    size_t next = body.find(delim, part_start);
    if (next == std::string::npos) {
      parts.push_back(body.substr(part_start));
      break;
    }
    size_t part_end = next;
    if (part_end > part_start && body[part_end - 1] == '\n') --part_end;
    if (part_end > part_start && body[part_end - 1] == '\r') --part_end;
    parts.push_back(body.substr(part_start, part_end - part_start));
    pos = next;
  }
  return parts;
}

std::string strip_html_impl(const std::string& html) {
  std::string s = html;
  size_t p;
  while ((p = s.find("<!--")) != std::string::npos) {
    size_t e = s.find("-->", p + 4);
    if (e == std::string::npos) { s.erase(p); break; }
    s.erase(p, e + 3 - p);
  }
  for (const char* tag : {"script", "style"}) {
    const std::string open = std::string("<") + tag;
    const std::string close = std::string("</") + tag;
    while (true) {
      std::string ls = util::to_lower(s);
      size_t a = ls.find(open);
      if (a == std::string::npos) break;
      size_t b = ls.find(close, a);
      if (b == std::string::npos) { s.erase(a); break; }
      size_t b2 = s.find('>', b);
      if (b2 == std::string::npos) { s.erase(a); break; }
      s.erase(a, b2 + 1 - a);
    }
  }
  std::string out;
  for (size_t i = 0; i < s.size(); ++i) {
    char c = s[i];
    if (c == '<') {
      size_t e = s.find('>', i + 1);
      if (e == std::string::npos) { out += '<'; continue; }  // 未闭合的 '<' 按字面输出，不再截断全文
      std::string tag = util::to_lower(util::trim(s.substr(i + 1, e - i - 1)));
      static const char* blocks[] = {"p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6",
                                     "table", "ul", "ol", "hr", "blockquote", "pre", "section", "article"};
      for (size_t k = 0; k < sizeof(blocks) / sizeof(blocks[0]); ++k) {
        const char* b = blocks[k];
        size_t bl = strlen(b);
        if (util::starts_with(tag, b) &&
            (tag.size() == bl || tag[bl] == ' ' || tag[bl] == '/' || tag[bl] == '\t')) {
          out += '\n';
          break;
        }
      }
      i = e;
    } else if (c == '&') {
      size_t semi = s.find(';', i);
      if (semi != std::string::npos && semi - i <= 12) {
        std::string ent = util::to_lower(s.substr(i + 1, semi - i - 1));
        std::string rep;
        if (ent == "nbsp") rep = " ";
        else if (ent == "lt") rep = "<";
        else if (ent == "gt") rep = ">";
        else if (ent == "amp") rep = "&";
        else if (ent == "quot") rep = "\"";
        else if (ent == "apos") rep = "'";
        else if (ent.size() > 1 && ent[0] == '#') {
          int code = 0;
          bool ok = true;
          size_t k = 1;
          if (ent[1] == 'x') { k = 2; for (; k < ent.size(); ++k) { char h = ent[k]; int v; if (h >= '0' && h <= '9') v = h - '0'; else if (h >= 'a' && h <= 'f') v = h - 'a' + 10; else { ok = false; break; } code = code * 16 + v; } }
          else { for (; k < ent.size(); ++k) { char h = ent[k]; if (!isdigit((unsigned char)h)) { ok = false; break; } code = code * 10 + (h - '0'); } }
          if (ok && code > 0 && code < 0x110000) {
            if (code < 0x80) rep += (char)code;
            else if (code < 0x800) { rep += (char)(0xC0 | (code >> 6)); rep += (char)(0x80 | (code & 0x3F)); }
            else if (code < 0x10000) { rep += (char)(0xE0 | (code >> 12)); rep += (char)(0x80 | ((code >> 6) & 0x3F)); rep += (char)(0x80 | (code & 0x3F)); }
            else { rep += (char)(0xF0 | (code >> 18)); rep += (char)(0x80 | ((code >> 12) & 0x3F)); rep += (char)(0x80 | ((code >> 6) & 0x3F)); rep += (char)(0x80 | (code & 0x3F)); }
          }
        }
        if (!rep.empty()) { out += rep; i = semi; continue; }
      }
      out += c;
    } else {
      out += c;
    }
  }
  // collapse whitespace and blank lines
  std::string res;
  std::vector<std::string> lines = util::split(out, '\n');
  for (auto& l : lines) {
    std::string t = util::trim(util::replace_all(l, "\r", ""));
    if (t.empty()) { if (!res.empty() && res.back() != '\n') res += '\n'; continue; }
    std::string collapsed;
    bool prev_space = false;
    for (char c : t) {
      if (c == ' ' || c == '\t') { if (!prev_space) collapsed += ' '; prev_space = true; }
      else { collapsed += c; prev_space = false; }
    }
    res += collapsed + "\n";
  }
  return util::trim(res);
}

struct PartContent {
  std::string text;
  std::string type; // "text/plain" or "text/html"
};

void collect_text(const std::string& raw_part, std::vector<PartContent>& out) {
  size_t pos = raw_part.find("\r\n\r\n");
  size_t seplen = 4;
  if (pos == std::string::npos) {
    pos = raw_part.find("\n\n");
    seplen = 2;
  }
  std::string head, body;
  if (pos == std::string::npos) {
    head = raw_part;
  } else {
    head = raw_part.substr(0, pos);
    body = raw_part.substr(pos + seplen);
  }
  Headers h;
  parse_headers(head, h);
  ContentType ct = parse_content_type(h.get("content-type", "text/plain"));
  if (util::starts_with(ct.type, "multipart/")) {
    auto it = ct.params.find("boundary");
    if (it != ct.params.end() && !it->second.empty()) {
      for (const auto& part : split_multipart(body, it->second)) collect_text(part, out);
    }
    return;
  }
  std::string cte = util::to_lower(h.get("content-transfer-encoding", ""));
  std::string decoded = body;
  if (cte == "base64") decoded = util::b64_decode(body);
  else if (cte == "quoted-printable") decoded = util::qp_decode(body);
  std::string charset = "";
  auto ci = ct.params.find("charset");
  if (ci != ct.params.end()) charset = ci->second;
  decoded = util::charset_to_utf8(decoded, charset);
  if (ct.type == "text/plain") {
    out.push_back({decoded, "text/plain"});
  } else if (ct.type == "text/html") {
    out.push_back({strip_html(decoded), "text/html"});
  }
}

int64_t days_from_civil(int y, unsigned m, unsigned d) {
  y -= (m <= 2) ? 1 : 0;
  const int era = (y >= 0 ? y : y - 399) / 400;
  const unsigned yoe = (unsigned)(y - era * 400);
  const unsigned doy = (153u * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
  const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return (int64_t)era * 146097 + (int64_t)doe - 719468;
}

} // namespace

std::string decode_encoded_words(const std::string& s) {
  std::string out;
  size_t i = 0;
  while (i < s.size()) {
    size_t start = s.find("=?", i);
    if (start == std::string::npos) { out += s.substr(i); break; }
    out += s.substr(i, start - i);
    size_t q1 = s.find('?', start + 2);
    if (q1 == std::string::npos) { out += s.substr(start); break; }
    std::string charset = s.substr(start + 2, q1 - (start + 2));
    size_t q2 = s.find('?', q1 + 1);
    if (q2 == std::string::npos) { out += s.substr(start); break; }
    std::string enc = s.substr(q1 + 1, q2 - (q1 + 1));
    size_t end = s.find("?=", q2 + 1);
    if (end == std::string::npos) { out += s.substr(start); break; }
    std::string data = s.substr(q2 + 1, end - (q2 + 1));
    std::string decoded;
    if (enc == "B" || enc == "b") decoded = util::b64_decode(data);
    else if (enc == "Q" || enc == "q") decoded = util::q_decode(data);
    else { out += s.substr(start, end + 2 - start); i = end + 2; continue; }
    out += util::charset_to_utf8(decoded, charset);
    i = end + 2;
  }
  return out;
}

std::string extract_addr(const std::string& from_header) {
  auto lt = from_header.find('<');
  if (lt != std::string::npos) {
    auto gt = from_header.find('>', lt);
    if (gt != std::string::npos) return util::to_lower(util::trim(from_header.substr(lt + 1, gt - lt - 1)));
  }
  auto at = from_header.find('@');
  if (at == std::string::npos) return util::to_lower(util::trim(from_header));
  size_t b = at, e = at;
  while (b > 0 && !isspace((unsigned char)from_header[b - 1]) && from_header[b - 1] != '(' &&
         from_header[b - 1] != '"' && from_header[b - 1] != ',' && from_header[b - 1] != ':') --b;
  while (e < from_header.size() && !isspace((unsigned char)from_header[e]) && from_header[e] != ')' &&
         from_header[e] != '>' && from_header[e] != ',' && from_header[e] != '"') ++e;
  return util::to_lower(util::trim(from_header.substr(b, e - b)));
}

int64_t parse_date(const std::string& s) {
  std::vector<std::string> tokens;
  std::string cur;
  for (char c : s) {
    if (isalnum((unsigned char)c) || c == ':' || c == '+' || c == '-') cur += c;
    else {
      if (!cur.empty()) { tokens.push_back(cur); cur.clear(); }
    }
  }
  if (!cur.empty()) tokens.push_back(cur);
  static const char* months[] = {"jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"};
  int day = -1, month = -1, year = -1, hh = 0, mm = 0, ss = 0, zone = 0;
  bool have_zone = false;
  for (auto& tok : tokens) {
    std::string lo = util::to_lower(tok);
    bool numeric = !tok.empty() && (tok[0] == '+' || tok[0] == '-' || isdigit((unsigned char)tok[0]));
    if (numeric && (tok[0] == '+' || tok[0] == '-')) {
      if (tok.size() == 5 && isdigit(tok[1]) && isdigit(tok[2]) && isdigit(tok[3]) && isdigit(tok[4])) {
        int zh = (tok[1] - '0') * 10 + (tok[2] - '0');
        int zm = (tok[3] - '0') * 10 + (tok[4] - '0');
        zone = (tok[0] == '-' ? -1 : 1) * (zh * 3600 + zm * 60);
        have_zone = true;
        continue;
      }
    }
    if (!numeric) {
      for (int k = 0; k < 12; ++k) {
        if (lo == months[k]) { month = k + 1; break; }
      }
      if (month == -1 && !have_zone) {
        if (lo == "gmt" || lo == "ut" || lo == "utc" || lo == "z") { zone = 0; have_zone = true; }
        else if (lo == "est") { zone = -5 * 3600; have_zone = true; }
        else if (lo == "edt") { zone = -4 * 3600; have_zone = true; }
        else if (lo == "cst") { zone = 8 * 3600; have_zone = true; }
        else if (lo == "cdt") { zone = -5 * 3600; have_zone = true; }
        else if (lo == "mst") { zone = -7 * 3600; have_zone = true; }
        else if (lo == "mdt") { zone = -6 * 3600; have_zone = true; }
        else if (lo == "pst") { zone = -8 * 3600; have_zone = true; }
        else if (lo == "pdt") { zone = -7 * 3600; have_zone = true; }
      }
    } else if (tok.find(':') != std::string::npos) {
      std::vector<std::string> p = util::split(tok, ':');
      if (p.size() >= 2) {
        hh = atoi(p[0].c_str());
        mm = atoi(p[1].c_str());
        if (p.size() >= 3) ss = atoi(p[2].c_str());
      }
    } else if (tok.size() == 4 && year == -1) {
      year = atoi(tok.c_str());
    } else if (tok.size() <= 2 && day == -1) {
      day = atoi(tok.c_str());
    }
  }
  if (day == -1 || month == -1 || year == -1) return 0;
  if (year < 100) year += (year < 50 ? 2000 : 1900);
  if (year < 1000 || month < 1 || month > 12 || day < 1 || day > 31) return 0;
  int64_t days = days_from_civil(year, (unsigned)month, (unsigned)day);
  return days * 86400 + hh * 3600 + mm * 60 + ss - zone;
}

std::string strip_html(const std::string& html) { return strip_html_impl(html); }

std::string encode_header(const std::string& s) {
  // 先做注入防护：任何 CR/LF 都会被替换成空格，杜绝通过主题/昵称注入新头
  std::string safe = util::sanitize_header(s);
  if (util::is_ascii(safe)) return safe;
  return "=?UTF-8?B?" + util::b64_encode(safe) + "?=";
}

bool parse_message(const std::string& raw, Msg& out) {
  size_t pos = raw.find("\r\n\r\n");
  size_t seplen = 4;
  if (pos == std::string::npos) {
    pos = raw.find("\n\n");
    seplen = 2;
  }
  std::string raw_h = raw;
  std::string raw_b;
  if (pos != std::string::npos) {
    raw_h = raw.substr(0, pos);
    raw_b = raw.substr(pos + seplen);
  }
  Headers h;
  parse_headers(raw_h, h);
  out.from = decode_encoded_words(h.get("from"));
  out.from_addr = extract_addr(out.from);
  out.subject = decode_encoded_words(h.get("subject"));
  out.date_raw = util::trim(h.get("date"));
  out.date_epoch = parse_date(out.date_raw);
  if (out.date_epoch == 0) out.date_epoch = util::now_epoch();
  out.message_id = util::trim(h.get("message-id"));

  std::vector<PartContent> parts;
  collect_text(raw, parts);
  std::string text;
  for (const auto& p : parts) {
    if (p.type == "text/plain") { text = p.text; break; }
  }
  if (util::trim(text).empty()) {
    for (const auto& p : parts) {
      if (p.type == "text/html") { text = p.text; break; }
    }
  }
  if (text.empty() && !raw_b.empty()) {
    // fall back to raw body if no text part was found
    text = raw_b;
  }
  out.body_text = util::trim(text);
  return true;
}

namespace {
// 生成全局近似唯一的 Message-ID（纳秒时间 + 计数器 + 随机数）。
// 修复原实现 rand()%100000 的问题：rand() 未播种、同一秒内多次发送会产生
// 相同 Message-ID，导致接收端去重时把不同邮件误判为同一条而丢信。
std::string make_msgid() {
  static std::mt19937_64 rng{std::random_device{}()};
  static std::atomic<uint64_t> counter{0};
  auto ns = std::chrono::duration_cast<std::chrono::nanoseconds>(
                std::chrono::steady_clock::now().time_since_epoch())
                .count();
  uint64_t n = counter.fetch_add(1);
  return "<" + std::to_string(util::now_epoch()) + "." + std::to_string(ns) + "." +
         std::to_string(n) + "." + std::to_string(rng() & 0xFFFFFFu) + "@email-chatter.local>";
}
} // namespace

std::string build_message(const std::string& from_display, const std::string& from_addr,
                          const std::string& to_addr, const std::string& subject,
                          const std::string& body, std::string* out_msgid) {
  std::string msgid = make_msgid();
  if (out_msgid) *out_msgid = msgid;
  std::string msg;
  // 地址/昵称/主题一律做注入清洗：不允许 CR/LF 进入任何头字段
  std::string from = util::sanitize_header(from_addr);
  std::string to = util::sanitize_header(to_addr);
  std::string from_hdr = from_display.empty()
                             ? from
                             : encode_header(from_display) + " <" + from + ">";
  msg += "From: " + from_hdr + "\r\n";
  msg += "To: <" + to + ">\r\n";
  msg += "Subject: " + encode_header(subject) + "\r\n";
  msg += "Date: " + util::format_rfc5322(util::now_epoch()) + "\r\n";
  msg += "Message-ID: " + msgid + "\r\n";
  msg += "MIME-Version: 1.0\r\n";
  msg += "Content-Type: text/plain; charset=UTF-8\r\n";
  msg += "Content-Transfer-Encoding: base64\r\n";
  msg += "X-Email-Chatter: 1\r\n";
  msg += "\r\n";
  std::string b = util::b64_encode(body);
  for (size_t i = 0; i < b.size(); i += 76) msg += b.substr(i, 76) + "\r\n";
  return msg;
}

} // namespace mime