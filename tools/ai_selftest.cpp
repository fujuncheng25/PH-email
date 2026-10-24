// Email Chatter AI 引擎自测 CLI（纯 JSON 输出到 stdout，调试信息走 stderr）。
//
// 用法：
//   ai-selftest tokenize <model.gguf> <text> [--no-special]
//       -> {"tokens":[ids...]}   （默认与 llama.cpp 一致：识别 <|im_start|> 等控制 token）
//   ai-selftest generate <model.gguf> <raw_prompt_text> <n_predict> [--no-newline-stop]
//   ai-selftest generate <model.gguf> --ids 1,2,3 <n_predict>
//       -> {"tokens":[...],"text":"..."}
//   ai-selftest logits <model.gguf> <comma-separated token ids> [--topk N]
//       -> {"topk":[{"id":int,"logit":float},...]}   （默认 top 10，按 logit 降序，%.6g）
//   ai-selftest title <model.gguf> <text>
//       -> {"title":"...","source":"ai","raw":"...","post":true|false}
//   ai-selftest heuristic <text>
//       -> {"title":"...","source":"heuristic"}
//   ai-selftest info <model.gguf>
//       -> 模型元数据 / 张量类型摘要（JSON）
//   ai-selftest manager-title <data_dir> <text>
//       -> 走 ai::Manager（data_dir/models/<默认模型文件>）：{"title","source","note",...,"status":{...}}
//   ai-selftest manager-status <data_dir> -> {"status":{...}}
//   ai-selftest download <data_dir> <model_file> [--url URL | --mirror MIRROR] [--cancel-after-ms N]
//       -> 走 ai::Manager 后台下载 + 轮询状态；输出最终 {"ok":bool,"status":{...},"part_exists":bool}
//   ai-selftest manager-idle <data_dir> <text> <idle_seconds>
//       -> 生成一次 → 等待 + idle_tick → 再生成，输出两次耗时（验证 5 分钟空闲卸载逻辑）
// 公共参数：--threads N（matvec 线程数，默认 min(CPU,8)）
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <string>
#include <thread>
#include <vector>

#include "ai.hpp"
#include "gguf.hpp"

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

namespace {

static double now_ms() {
  using clock = std::chrono::steady_clock;
  static const clock::time_point t0 = clock::now();
  return std::chrono::duration<double, std::milli>(clock::now() - t0).count();
}

static std::string json_escape(const std::string& s) {
  std::string o;
  o.reserve(s.size() + 8);
  for (unsigned char c : s) {
    switch (c) {
      case '"': o += "\\\""; break;
      case '\\': o += "\\\\"; break;
      case '\n': o += "\\n"; break;
      case '\r': o += "\\r"; break;
      case '\t': o += "\\t"; break;
      case '\b': o += "\\b"; break;
      case '\f': o += "\\f"; break;
      default:
        if (c < 0x20) {
          char buf[8];
          std::snprintf(buf, sizeof buf, "\\u%04x", (unsigned)c);
          o += buf;
        } else {
          o.push_back((char)c);
        }
    }
  }
  return o;
}

static std::string fmt_float(float v) {
  char buf[32];
  std::snprintf(buf, sizeof buf, "%.6g", (double)v);
  return buf;
}

static std::vector<int> parse_ids(const std::string& csv) {
  std::vector<int> ids;
  size_t start = 0;
  for (;;) {
    const size_t p = csv.find(',', start);
    const std::string part = (p == std::string::npos) ? csv.substr(start) : csv.substr(start, p - start);
    if (!part.empty()) ids.push_back(std::atoi(part.c_str()));
    if (p == std::string::npos) break;
    start = p + 1;
  }
  return ids;
}

static void print_ids(const std::vector<int>& ids) {
  std::printf("[");
  for (size_t i = 0; i < ids.size(); ++i) {
    std::printf("%s%d", i ? "," : "", ids[i]);
  }
  std::printf("]");
}

static int load_engine(gguf::Qwen2Engine& eng, const std::string& model) {
  std::string err;
  const double t0 = now_ms();
  if (!eng.load(model, err)) {
    std::fprintf(stderr, "[ai-selftest] 加载失败：%s\n", err.c_str());
    std::printf("{\"error\":\"%s\"}\n", json_escape(err).c_str());
    return 2;
  }
  std::fprintf(stderr, "[ai-selftest] 模型加载完成 %.0f ms：%s（%.1f MB）\n", now_ms() - t0,
               eng.model_name().c_str(), (double)eng.memory_bytes() / 1048576.0);
  return 0;
}

static int usage() {
  std::fprintf(stderr,
               "用法：\n"
               "  ai-selftest tokenize <model.gguf> <text> [--add-special]\n"
               "  ai-selftest generate <model.gguf> <text> <n_predict> [--no-newline-stop]\n"
               "  ai-selftest generate <model.gguf> --ids 1,2,3 <n_predict>\n"
               "  ai-selftest logits <model.gguf> <ids_csv> [--topk N]\n"
               "  ai-selftest title <model.gguf> <text>\n"
               "  ai-selftest heuristic <text>\n"
               "  ai-selftest info <model.gguf>\n"
               "  ai-selftest dumprow <model.gguf> <tensor> <row> [--count N]\n"
               "  ai-selftest manager-title <data_dir> <text>\n"
               "  ai-selftest manager-status <data_dir>\n"
               "  ai-selftest download <data_dir> <model_file> [--url U | --mirror M] [--cancel-after-ms N]\n"
               "  ai-selftest manager-idle <data_dir> <text> <idle_seconds>\n"
               "公共：--threads N\n");
  return 1;
}

static std::string status_json(const ai::Status& st) {
  char buf[2048];
  const int percent = st.total_bytes > 0 ? (int)(100 * st.downloaded_bytes / st.total_bytes) : 0;
  std::snprintf(buf, sizeof buf,
                "{\"enabled\":%s,\"model_ready\":%s,\"downloading\":%s,\"busy\":%s,"
                "\"downloaded_bytes\":%lld,\"total_bytes\":%lld,\"percent\":%d,"
                "\"error\":\"%s\",\"model_file\":\"%s\",\"mirror\":\"%s\",\"engine\":\"%s\"}",
                st.enabled ? "true" : "false", st.model_ready ? "true" : "false",
                st.downloading ? "true" : "false", st.busy ? "true" : "false",
                (long long)st.downloaded_bytes, (long long)st.total_bytes, percent,
                json_escape(st.error).c_str(), json_escape(st.model_file).c_str(),
                json_escape(st.mirror).c_str(), json_escape(st.engine).c_str());
  return buf;
}

static void set_env_var(const char* name, const std::string& value) {
#ifdef _WIN32
  _putenv_s(name, value.c_str());
#else
  setenv(name, value.c_str(), 1);
#endif
}

static int do_info(const std::string& model) {
  gguf::Model m;
  std::string err;
  if (!m.load(model, err)) {
    std::fprintf(stderr, "加载失败：%s\n", err.c_str());
    std::printf("{\"error\":\"%s\"}\n", json_escape(err).c_str());
    return 2;
  }
  std::printf("{\"file\":\"%s\",\"size\":%zu,\"alignment\":%llu,", json_escape(model).c_str(),
              m.file_size(), (unsigned long long)m.alignment());
  std::printf("\"architecture\":\"%s\",", json_escape(m.get_str("general.architecture")).c_str());
  std::printf("\"block_count\":%lld,", (long long)m.get_int("qwen2.block_count", 0));
  std::printf("\"embedding_length\":%lld,", (long long)m.get_int("qwen2.embedding_length", 0));
  std::printf("\"feed_forward_length\":%lld,", (long long)m.get_int("qwen2.feed_forward_length", 0));
  std::printf("\"head_count\":%lld,", (long long)m.get_int("qwen2.attention.head_count", 0));
  std::printf("\"head_count_kv\":%lld,", (long long)m.get_int("qwen2.attention.head_count_kv", 0));
  std::printf("\"rope_freq_base\":%s,",
              fmt_float((float)m.get_float("qwen2.rope.freq_base", 1e6)).c_str());
  std::printf("\"rms_eps\":%s,",
              fmt_float((float)m.get_float("qwen2.attention.layer_norm_rms_epsilon", 1e-6)).c_str());
  const auto* toks = m.get_str_array("tokenizer.ggml.tokens");
  const auto* merges = m.get_str_array("tokenizer.ggml.merges");
  std::printf("\"n_vocab\":%d,\"n_merges\":%d,", toks ? (int)toks->size() : 0,
              merges ? (int)merges->size() : 0);
  std::printf("\"ties_output\":%s,", m.tensor("output.weight") ? "false" : "true");
  // 张量类型统计
  int f32 = 0, f16 = 0, bf16 = 0, q8 = 0, q4k = 0, q5k = 0, q6k = 0, q4 = 0, q5 = 0, other = 0;
  const auto& ts = m.tensors();
  for (const auto& t : ts) {
    switch (t.type) {
      case gguf::T_F32: ++f32; break;
      case gguf::T_F16: ++f16; break;
      case gguf::T_BF16: ++bf16; break;
      case gguf::T_Q8_0: ++q8; break;
      case gguf::T_Q4_K: ++q4k; break;
      case gguf::T_Q5_K: ++q5k; break;
      case gguf::T_Q6_K: ++q6k; break;
      case gguf::T_Q4_0:
      case gguf::T_Q4_1: ++q4; break;
      case gguf::T_Q5_0:
      case gguf::T_Q5_1: ++q5; break;
      default: ++other; break;
    }
  }
  char tbuf[256];
  std::snprintf(tbuf, sizeof tbuf,
                "\"types\":{\"F32\":%d,\"F16\":%d,\"BF16\":%d,\"Q8_0\":%d,\"Q4_K\":%d,\"Q5_K\":%d,"
                "\"Q6_K\":%d,\"Q4_0/1\":%d,\"Q5_0/1\":%d,\"other\":%d}",
                f32, f16, bf16, q8, q4k, q5k, q6k, q4, q5, other);
  std::printf("%s,\"n_tensors\":%d}\n", tbuf, (int)ts.size());
  return 0;
}

static int run(const std::vector<std::string>& args) {
  if (args.size() < 2) return usage();
  const std::string cmd = args[1];
  std::vector<std::string> pos;
  bool add_special = true;
  bool no_newline_stop = false;
  int topk = 10;
  int threads = 0;
  int opt_count = -1;
  int cancel_after_ms = -1;
  std::string opt_url;
  std::string opt_mirror;
  std::string opt_model_file;
  std::vector<int> opt_ids;
  bool have_ids = false;
  for (size_t i = 2; i < args.size(); ++i) {
    const std::string& a = args[i];
    if (a == "--add-special") {
      add_special = true;
    } else if (a == "--no-special") {
      add_special = false;
    } else if (a == "--no-newline-stop") {
      no_newline_stop = true;
    } else if (a == "--url" && i + 1 < args.size()) {
      opt_url = args[++i];
    } else if (a == "--mirror" && i + 1 < args.size()) {
      opt_mirror = args[++i];
    } else if (a == "--model-file" && i + 1 < args.size()) {
      opt_model_file = args[++i];
    } else if (a == "--cancel-after-ms" && i + 1 < args.size()) {
      cancel_after_ms = std::atoi(args[++i].c_str());
    } else if (a == "--topk" && i + 1 < args.size()) {
      topk = std::atoi(args[++i].c_str());
    } else if (a == "--count" && i + 1 < args.size()) {
      opt_count = std::atoi(args[++i].c_str());
    } else if (a == "--threads" && i + 1 < args.size()) {
      threads = std::atoi(args[++i].c_str());
    } else if (a == "--ids" && i + 1 < args.size()) {
      opt_ids = parse_ids(args[++i]);
      have_ids = true;
    } else {
      pos.push_back(a);
    }
  }
  if (threads > 0) {
#ifdef _WIN32
    _putenv_s("AI_THREADS", std::to_string(threads).c_str());
#else
    setenv("AI_THREADS", std::to_string(threads).c_str(), 1);
#endif
  }

  if (cmd == "heuristic") {
    const std::string text = pos.empty() ? std::string() : pos[0];
    std::printf("{\"title\":\"%s\",\"source\":\"heuristic\"}\n",
                json_escape(ai::heuristic_title(text)).c_str());
    return 0;
  }
  if (cmd == "manager-status") {
    if (pos.empty()) return usage();
    ai::Manager& mg = ai::manager();
    mg.init(pos[0]);
    if (!opt_model_file.empty()) {
      ai::Config c = mg.config();
      c.model_file = opt_model_file;
      mg.set_config(c);
    }
    std::printf("{\"status\":%s}\n", status_json(mg.status()).c_str());
    return 0;
  }
  if (cmd == "manager-title" || cmd == "manager-idle") {
    if (pos.size() < 2) return usage();
    const std::string data_dir = pos[0];
    const std::string text = pos[1];
    int idle_sec = 0;
    if (cmd == "manager-idle") {
      if (pos.size() < 3) return usage();
      idle_sec = std::atoi(pos[2].c_str());
      set_env_var("AI_IDLE_SECONDS", std::to_string(std::max(1, idle_sec)));
    }
    ai::Manager& mg = ai::manager();
    mg.init(data_dir);
    ai::Config c = mg.config();
    c.enabled = true;
    if (!opt_model_file.empty()) c.model_file = opt_model_file;
    mg.set_config(c);
    std::string src, note;
    const double t0 = now_ms();
    const std::string title = mg.generate_title(text, src, note);
    const double dt1 = now_ms() - t0;
    std::printf("{\"title\":\"%s\",\"source\":\"%s\",\"note\":\"%s\",\"ms\":%.1f,"
                "\"status\":%s",
                json_escape(title).c_str(), json_escape(src).c_str(), json_escape(note).c_str(),
                dt1, status_json(mg.status()).c_str());
    if (cmd == "manager-idle" && idle_sec > 0) {
      // 第二次调用（模型已加载，应明显更快），然后空闲卸载，再第三次（应重新加载）
      std::string src1b, note1b;
      const double t1a = now_ms();
      const std::string title1b = mg.generate_title(text, src1b, note1b);
      const double dt1b = now_ms() - t1a;
      std::this_thread::sleep_for(std::chrono::seconds(idle_sec));
      mg.idle_tick();
      std::string src2, note2;
      const double t1 = now_ms();
      const std::string title2 = mg.generate_title(text, src2, note2);
      const double dt2 = now_ms() - t1;
      std::printf(",\"title2\":\"%s\",\"ms2\":%.1f,"
                  "\"title3\":\"%s\",\"source3\":\"%s\",\"note3\":\"%s\",\"ms3\":%.1f",
                  json_escape(title1b).c_str(), dt1b, json_escape(title2).c_str(),
                  json_escape(src2).c_str(), json_escape(note2).c_str(), dt2);
    }
    std::printf("}\n");
    return 0;
  }
  if (cmd == "download") {
    if (pos.size() < 2) return usage();
    const std::string data_dir = pos[0];
    const std::string model_file = pos[1];
    ai::Manager& mg = ai::manager();
    mg.init(data_dir);
    ai::Config c = mg.config();
    c.enabled = true;
    c.model_file = model_file;
    if (!opt_url.empty()) c.model_url = opt_url;
    if (!opt_mirror.empty()) c.mirror = opt_mirror;
    mg.set_config(c);
    std::string err;
    const double t0 = now_ms();
    if (!mg.start_download(err)) {
      std::printf("{\"ok\":false,\"error\":\"%s\",\"status\":%s}\n", json_escape(err).c_str(),
                  status_json(mg.status()).c_str());
      return 4;
    }
    if (cancel_after_ms >= 0) {
      std::this_thread::sleep_for(std::chrono::milliseconds(cancel_after_ms));
      mg.cancel_download();
    }
    ai::Status st = mg.status();
    for (int i = 0; i < 1800; ++i) {
      st = mg.status();
      if (!st.downloading) break;
      std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
    st = mg.status();
    const std::string model_path = data_dir + "/models/" + model_file;
    std::error_code ec;
    const bool part_exists = std::filesystem::exists(std::filesystem::u8path(model_path + ".part"), ec);
    const bool model_exists = std::filesystem::exists(std::filesystem::u8path(model_path), ec);
    std::printf("{\"ok\":%s,\"elapsed_ms\":%.1f,\"part_exists\":%s,\"model_exists\":%s,"
                "\"error\":\"%s\",\"status\":%s}\n",
                (st.model_ready && model_exists && !st.downloading) ? "true" : "false",
                now_ms() - t0, part_exists ? "true" : "false", model_exists ? "true" : "false",
                json_escape(st.error).c_str(), status_json(st).c_str());
    return (st.model_ready && model_exists) ? 0 : 5;
  }
  if (cmd == "dumprow") {
    if (pos.size() < 3) return usage();
    gguf::Model m;
    std::string err;
    if (!m.load(pos[0], err)) {
      std::printf("{\"error\":\"%s\"}\n", json_escape(err).c_str());
      return 2;
    }
    const gguf::Model::TensorInfo* t = m.tensor(pos[1]);
    if (!t) {
      std::printf("{\"error\":\"tensor not found: %s\"}\n", json_escape(pos[1]).c_str());
      return 2;
    }
    const uint64_t row = (uint64_t)std::strtoull(pos[2].c_str(), nullptr, 10);
    std::vector<float> vals;
    if (!gguf::dequantize_row(*t, row, vals)) {
      std::printf("{\"error\":\"dequantize failed\"}\n");
      return 3;
    }
    int count = (int)vals.size();
    if (opt_count > 0) count = std::min(count, opt_count);
    std::printf("{\"tensor\":\"%s\",\"type\":\"%s\",\"row\":%llu,\"n\":%d,\"values\":[",
                json_escape(t->name).c_str(), gguf::type_name(t->type), (unsigned long long)row,
                count);
    for (int i = 0; i < count; ++i) {
      char buf[40];
      std::snprintf(buf, sizeof buf, "%.9g", (double)vals[(size_t)i]);
      std::printf("%s%s", i ? "," : "", buf);
    }
    std::printf("]}\n");
    return 0;
  }
  if (cmd == "info") {
    if (pos.empty()) return usage();
    return do_info(pos[0]);
  }
  if (!(cmd == "tokenize" || cmd == "generate" || cmd == "logits" || cmd == "title")) {
    std::fprintf(stderr, "未知命令：%s\n", cmd.c_str());
    return usage();
  }
  if (pos.empty()) return usage();
  const std::string model = pos[0];
  gguf::Qwen2Engine eng;
  if (int rc = load_engine(eng, model)) return rc;

  if (cmd == "tokenize") {
    const std::string text = pos.size() > 1 ? pos[1] : std::string();
    const std::vector<int> ids = eng.tokenizer().encode(text, add_special);
    std::printf("{\"tokens\":");
    print_ids(ids);
    std::printf("}\n");
    return 0;
  }
  if (cmd == "generate") {
    std::vector<int> prompt;
    std::string text;
    int n_predict = 16;
    if (have_ids) {
      prompt = opt_ids;
      if (pos.size() > 1) n_predict = std::atoi(pos[1].c_str());
    } else {
      text = pos.size() > 1 ? pos[1] : std::string();
      if (pos.size() > 2) n_predict = std::atoi(pos[2].c_str());
      // raw prompt 入口与 tokenize 保持一致：识别 <|im_start|> 等特殊 token
      prompt = eng.tokenizer().encode(text, true);
    }
    std::vector<int> out;
    std::string err;
    const double t0 = now_ms();
    if (!eng.generate(prompt, n_predict, !no_newline_stop, out, err)) {
      std::fprintf(stderr, "生成失败：%s\n", err.c_str());
      std::printf("{\"error\":\"%s\"}\n", json_escape(err).c_str());
      return 3;
    }
    const double dt = now_ms() - t0;
    const std::string out_text = eng.tokenizer().decode(out);
    std::fprintf(stderr, "[ai-selftest] prompt=%zu tokens, generated=%zu tokens, %.1f ms (%.2f tok/s)\n",
                 prompt.size(), out.size(), dt, out.empty() ? 0.0 : (1000.0 * (double)out.size() / dt));
    std::printf("{\"tokens\":");
    print_ids(out);
    std::printf(",\"text\":\"%s\"}\n", json_escape(out_text).c_str());
    return 0;
  }
  if (cmd == "logits") {
    if (pos.size() < 2) return usage();
    const std::vector<int> ids = parse_ids(pos[1]);
    std::vector<float> logits;
    std::string err;
    const double t0 = now_ms();
    if (!eng.compute_logits(ids, logits, err)) {
      std::fprintf(stderr, "前向失败：%s\n", err.c_str());
      std::printf("{\"error\":\"%s\"}\n", json_escape(err).c_str());
      return 3;
    }
    std::fprintf(stderr, "[ai-selftest] 前向 %zu tokens，%.1f ms\n", ids.size(), now_ms() - t0);
    std::vector<int> idx(logits.size());
    for (size_t i = 0; i < idx.size(); ++i) idx[i] = (int)i;
    const int k = std::max(1, std::min<int>(topk, (int)logits.size()));
    std::partial_sort(idx.begin(), idx.begin() + k, idx.end(),
                      [&](int a, int b) { return logits[(size_t)a] > logits[(size_t)b]; });
    std::printf("{\"topk\":[");
    for (int i = 0; i < k; ++i) {
      std::printf("%s{\"id\":%d,\"logit\":%s}", i ? "," : "", idx[(size_t)i],
                  fmt_float(logits[(size_t)idx[(size_t)i]]).c_str());
    }
    std::printf("]}\n");
    return 0;
  }
  // title
  const std::string text = pos.size() > 1 ? pos[1] : std::string();
  std::vector<int> ids = eng.tokenizer().encode(ai::build_prompt(text), true);
  std::vector<int> out;
  std::string err;
  if (!eng.generate(ids, 24, true, out, err)) {
    std::fprintf(stderr, "生成失败：%s\n", err.c_str());
    std::printf("{\"error\":\"%s\"}\n", json_escape(err).c_str());
    return 3;
  }
  const std::string raw = eng.tokenizer().decode(out);
  const std::string title = ai::postprocess_title(raw);
  std::printf("{\"title\":\"%s\",\"source\":\"%s\",\"raw\":\"%s\",\"post\":%s}\n",
              json_escape(title.empty() ? ai::heuristic_title(text) : title).c_str(),
              title.empty() ? "heuristic" : "ai", json_escape(raw).c_str(),
              title.empty() ? "false" : "true");
  return 0;
}

}  // namespace

#ifdef _WIN32
static std::string wide_to_utf8(const wchar_t* w) {
  if (!w) return std::string();
  const int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
  if (n <= 0) return std::string();
  std::string s((size_t)n - 1, '\0');
  WideCharToMultiByte(CP_UTF8, 0, w, -1, &s[0], n, nullptr, nullptr);
  return s;
}

int wmain(int argc, wchar_t** argv) {
  std::vector<std::string> args;
  args.reserve((size_t)argc);
  for (int i = 0; i < argc; ++i) args.push_back(wide_to_utf8(argv[i]));
  return run(args);
}
#else
int main(int argc, char** argv) {
  std::vector<std::string> args;
  args.reserve((size_t)argc);
  for (int i = 0; i < argc; ++i) args.push_back(argv[i]);
  return run(args);
}
#endif
