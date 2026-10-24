#pragma once
// Email Chatter 2.0 本地 AI 标题引擎（C++）
// 接口契约见 FEATURE-SPEC.md §6.5；cpp-core 通过本头文件调用。
// 实现文件：ai.cpp（下载/管理/启发式）、gguf.cpp（GGUF 解析 + Qwen2 推理）。
#include <string>

namespace ai {

// 配置（对应 data/config.json 的 ai 对象；缺失字段用默认值）。
struct Config {
  bool enabled = false;
  std::string mirror = "https://hf-mirror.com";
  std::string model_url;  // 非空时只使用它，忽略内置候选 URL
  std::string model_file = "qwen2.5-0.5b-instruct-q4_k_m.gguf";
};

// /api/state 顶层 ai 对象 / /api/ai/status 的 ai 字段。
struct Status {
  bool enabled = false;
  bool model_ready = false;
  bool downloading = false;
  bool busy = false;
  long long downloaded_bytes = 0;
  long long total_bytes = 0;
  std::string error;
  std::string mirror;
  std::string model_file;
  std::string engine;
};

// 进程级单例。所有方法线程安全（可在 HTTP 线程 / poller 线程并发调用）。
class Manager {
 public:
  Manager();
  ~Manager();
  Manager(const Manager&) = delete;
  Manager& operator=(const Manager&) = delete;

  void init(const std::string& data_dir);  // 建 data/models 等；可重复调用
  void set_config(const Config& c);
  Config config() const;
  Status status() const;
  bool start_download(std::string& err);  // 立即返回，后台线程下载
  void cancel_download();                 // 置取消标记；线程退出时删除 .part
  // 阻塞生成标题；始终返回标题：
  //   模型成功   -> source="ai"，note 为空
  //   不可用/失败 -> source="heuristic"，note 为原因
  // 内部互斥，同一时刻仅一个生成/下载占用推理资源。
  std::string generate_title(const std::string& text, std::string& source,
                             std::string& note);
  void idle_tick();  // 空闲卸载（poller 每轮调用；空闲 5 分钟后释放模型内存）
};

Manager& manager();

// 启发式标题（无模型/失败/未启用时使用，C++/Node/前端一致）：
// 取正文第一个非空行，去 markdown 标记与多余空白，截断 30 字符（超长加 …）；空则 "无主题"。
std::string heuristic_title(const std::string& text);

// §6.3 提示词构造（正文按 UTF-8 码点截断到 600 字符）与模型输出后处理。
// 供 ai-selftest 与 Node 实现对齐使用；app 层不需要直接调用。
std::string build_prompt(const std::string& text);
std::string postprocess_title(const std::string& raw);

}  // namespace ai
