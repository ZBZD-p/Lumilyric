# Lumilyric

LRC 歌词播放器，可以导出歌词视频。支持逐词 / 逐字高亮、Apple Music 风格的滚动歌词和流光背景、辉光、封面显示，以及逐词显示模式，导出 MP4（可带原曲音频）、透明 MOV 或 PNG 序列。

## 快速开始

1. 第一次使用：双击 `scripts\setup_base.bat`，创建 Python 环境（只有 numpy，约 60 MB，只需一次）。
2. 双击 **`start_server.bat`**，浏览器会自动打开 `http://127.0.0.1:8765/`。用页面期间保持这个黑色窗口开着。
3. 载入歌词（`.lrc` / `.ttml`，也可以从「歌词库」搜索），可选载入音频，就能播放和导出。

## 跟随播放器

在电脑上的 QQ 音乐、网易云音乐、酷狗等播放器里放歌，页面自动识别正在播放的歌、下载逐字歌词，并跟着播放器的进度走（暂停、拖动、切歌都会跟上）。只在 Windows 10/11 上可用，且只在用 `start_server.bat` 打开的页面里有这个按钮（单文件版没有）。

1. 一次性安装：双击 `scripts\setup_nowplaying.bat`（另外需要已经装好 LDDC：`scripts\setup_lddc.bat`）。
2. 重新打开 `start_server.bat`，页面底部出现「跟随播放器」，点一下开启。有多个播放器同时在跑时，旁边会多出一个下拉框选择跟随哪一个。
3. 歌词和播放器有固定延迟时，用「偏移」修正；偏移按播放器分别记住。
4. 想先确认自己的播放器能不能被识别：运行 `scripts\probe_nowplaying.bat`，它每 0.5 秒打印一次系统里所有媒体会话（原始值同时写进 `tools
owplaying-probe.log`）。

背景律动：跟随时没有音频文件可分析，改为抓取电脑正在播放的声音，只计算低频响度这一个数值（不保存、不上传任何音频）。需要 `setup_nowplaying.bat` 里一并安装的 PyAudioWPatch（约 100 KB）。抓的是整个系统输出，浏览器、通知音也会混进去。

缓存：找到的歌词和选定的高清封面会存在 `tools\cache`（同一首歌第二次放几乎是立刻出现，不用再联网），总大小上限默认 300 MB（环境变量 `LRC_CACHE_MB` 可改），超出时先删最久没用的。想清空就直接删这个文件夹。

原理：读取 Windows 的系统媒体会话（和音量弹出框里显示的“正在播放”是同一份数据），不会注入或修改播放器。

| 播放器 | 程序 ID | 歌名 / 歌手 | 进度 | 封面 | 说明 |
| --- | --- | --- | --- | --- | --- |
| QQ 音乐 | `QQMusic.exe` | 有（含专辑） | 有，随播放更新 | 300×300 | 不接受从页面拖进度；切歌时进度和时长会晚一点才更新（已处理） |
| 酷狗音乐 | `kugou` | 有（没有专辑） | 没有 | 120×120 | 从切歌起自己计时，需要手动拖进度条对准 |
| 网易云音乐 | `cloudmusic.exe` | 有（没有专辑） | 没有 | 135×135 | 同酷狗：自己计时，手动校准 |
| Chrome（网页音频） | `Chrome` | 有 | 不一定可靠 | 看网页 | 只能读到，不保证 |

以上是在这台电脑上实际读出来的。没测过的播放器不保证可用：有的播放器不接入系统媒体会话，或者只在暂停 / 拖动时才更新进度。

只想播放和导出、不需要识别对齐：运行 `python scripts/build_single.py`，得到单文件版 `dist/lumilyric.html`，双击就能打开。

## 文件夹

```
lumilyric/
├─ start_server.bat      启动本地程序并打开页面（日常只需要它）
├─ web/                  页面
│  ├─ index.html         页面结构
│  ├─ style.css          样式
│  ├─ js/                代码（ES module），按功能分子目录（见下表）
│  └─ vendor/            第三方库：mp4-muxer（MIT）
├─ server/               本地程序（Python）
│  ├─ server.py          本地服务：提供页面、识别、对齐、歌词搜索、封面搜索
│  ├─ align_lrc.py       wav2vec2 逐字强制对齐（中文 / 英文）
│  ├─ lddc_bridge.py     QQ 音乐 / 酷狗 / 网易云 逐字歌词（通过 LDDC）
│  ├─ qt_stub/           PySide6（Qt，215 MB）的替身：LDDC 搜词只用到几个名字，用纯 Python 顶替（有测试）
│  ├─ cover_search.py    专辑封面搜索
│  ├─ nowplaying.py      跟随播放器：读取系统媒体会话、快照、控制
│  ├─ track_state.py     切歌后什么时候播放器的进度/时长可信（纯逻辑，有测试）
│  ├─ lyrics_match.py    给正在播放的歌挑歌词、打分（纯逻辑，有测试）
│  ├─ disk_cache.py      歌词和高清封面的磁盘缓存（tools\cache，有测试）
│  └─ audio_level.py     跟随播放器：抓取系统声音的低频响度（背景律动）
├─ desktop/
│  ├─ app.py             桌面版：启动本地服务并打开 WebView2 窗口
│  ├─ launcher.cs        Lumilyric.exe 的源码（只负责无黑窗口地启动 app.py）
│  └─ build.py           打包：自带 Python、依赖库、页面和服务
├─ scripts/
│  ├─ setup_base.bat     一次性安装：Python 环境（tools\align-env，只有 numpy）
│  ├─ setup_align.bat    可选扩展：逐字对齐（torch、transformers）
│  ├─ setup_whisper.bat  可选扩展：自动识别（whisper.cpp 和模型）
│  ├─ setup_lddc.bat     一次性安装：LDDC 歌词库
│  ├─ setup_nowplaying.bat  一次性安装：跟随播放器需要的系统媒体会话库
│  ├─ probe_nowplaying.bat  探测：列出系统里所有正在播放的媒体会话
│  ├─ transcribe.bat     命令行识别：把音频拖上去，生成 Whisper JSON
│  ├─ align.bat          命令行对齐：把音频和 .lrc 一起拖上去
│  ├─ build_single.py    生成单文件版页面 dist/lumilyric.html
│  ├─ build_desktop.bat  生成桌面版 dist\Lumilyric（见「桌面版」）
│  └─ tidy_old_files.bat 旧版文件夹整理（只需运行一次）
├─ tests/                测试：python tests/test_track_state.py、tests/test_lyrics_match.py、tests/test_disk_cache.py、tests/test_qt_stub.py、tests/test_audio_level.py；node tests/test_transition.js、tests/test_look_melt.js、tests/test_seg_thumb.js、tests/test_smooth_scroll.js
├─ models/               Whisper 模型（ggml-*.bin），不进仓库
├─ tools/                whisper.cpp、Python 环境、模型缓存、临时文件，不进仓库
└─ examples/             示例歌词
```

### web/js 各文件

页面的代码是一组 ES module：`index.html` 只加载 `js/app.js`，它按下面的顺序列出所有文件。每个文件用 `import` 写明自己要用谁的东西，**只会引用顺序在它之前的文件**；需要后面文件里的名字时（比如 `settings.js` 要调用 `follow.js` 的函数），后面的文件在加载完时把它放进 `core/late.js` 的 `late` 对象，前面的文件在运行时用 `late.名字` 调用。这样文件始终严格按 `app.js` 里的顺序运行。

被别的文件赋值的共享变量（`cur`、`mode`、`fx` 等）由定义它的文件导出一个 `setXxx()` 函数，别的文件用它来改（模块里不能给导入的名字赋值）。

| 目录 / 文件 | 内容 |
| --- | --- |
| `app.js` | 入口：按顺序列出所有文件 |
| `core/core.js` | 示例歌词、共享状态、LRC 解析 |
| `core/lyrics.js` | TTML、Whisper 逐词对齐、逐词 LRC 读写 |
| `core/settings.js` | 效果设置（`fx`）、离场预设、逐字高亮时间、辉光 |
| `core/sync.js` | 歌词时间偏移输入 |
| `core/late.js` | 前向引用：后加载的文件把名字放在这里，先加载的文件用 `late.名字` 调用 |
| `render/view-dom.js` | 单句布局：长句拆分、网页渲染 |
| `render/text-canvas.js` | 画布文字：缓动、高亮扫光、文字缓存、单句画布渲染 |
| `render/bloom.js` | WebGL 辉光 |
| `render/song-transition.js` | 滚动歌词切歌：旧的拖出、新的拖入（纯逻辑，有测试） |
| `render/layout-scroll.js` | 滚动歌词布局 |
| `render/layout-words.js` | 逐词布局和它的动画预设 |
| `render/smooth-scroll.js` | 滚轮平滑滚动（有测试） |
| `render/frame.js` | 封面面板、整帧合成（`drawFrame`） |
| `background/background.js` | 流光背景、节拍跳动、画布实时显示 |
| `background/look-melt.js` | 背景外观渐变：换歌和切换背景样式时混色（纯逻辑，有测试） |
| `background/cover-extract.js` | 读取音频文件里的封面 |
| `glass/glass.js` | 液态玻璃界面：WebGL 实时绘制折射和边缘高光 |
| `glass/seg-thumb.js`、`glass-toggle.js`、`glass-slider.js` | 分段开关、开关、滑块上的玻璃滑块 |
| `export/export.js` | 导出 MP4 / MOV / PNG ZIP、音频、保存位置 |
| `ui/ui-effects.js` | 效果设置面板、封面搜索 |
| `ui/fonts.js` | 歌词字体设置：中文 / 英文字体、加粗、字号，歌词和译文各一组 |
| `ui/dropdown.js`、`menu.js`、`desktop.js` | 下拉框、「更多」菜单、桌面版窗口按钮 |
| `player/library.js` | 歌词库：AMLL TTML DB、LDDC |
| `player/follow.js` | 跟随播放器：轮询、时间平滑、切歌找歌词和封面 |
| `player/helper.js` | 页面里的自动识别 / 对齐 |
| `main.js` | 性能显示、主循环、播放控制、载入文件、快捷键 |

单文件版（`scripts/build_single.py`）把这些模块按浏览器会运行的顺序拼成一个普通脚本，所以所有文件的顶层名字必须互不相同，构建时会检查。

## 桌面版

不用浏览器、不用自己装 Python 的版本：一个文件夹，双击 `Lumilyric.exe` 就是一个独立窗口，没有黑色命令行窗口。

- 生成：先关掉正在运行的桌面版，再双击 `scripts\build_desktop.bat`（要先有 `tools\align-env`）。重新生成不会清掉它的 `tools\`（缓存和设置）。结果在 `dist\Lumilyric\`，同时打一个 `dist\Lumilyric.zip`。实测文件夹约 33 MB，压缩包约 15 MB。
- 给别人用：把压缩包发过去，解压到一个能写入的位置（不要放 `C:\Program Files`），双击 `Lumilyric.exe`。对方电脑不需要 Python。
- 窗口没有标题栏，页面铺满整个窗口：最上面一条（24 像素）可以拖动窗口、双击最大化，右上角四个小圆点是页面自己画的全屏 / 最小化 / 最大化 / 关闭，四条边照常缩放。全屏（盖住任务栏）：F11 或第一个圆点，F11 或 Esc 退出。
- 窗口用的是 Windows 自带的 WebView2（就是 Edge 的内核），页面在里面和在 Edge 里一样走显卡。电脑上没有 WebView2 时改用 Edge 的应用窗口，再没有就用默认浏览器，这两种情况会多一个小对话框，关掉它就是退出。
- 带的功能：页面本身、导出、歌词库和 QQ / 酷狗 / 网易云搜词、封面搜索、跟随播放器（含律动）。**没有带**自动识别和逐字对齐（1 GB 以上），要用时仍然用项目文件夹里的 `start_server.bat`。
- 运行时产生的东西都在它自己的 `tools\` 里：`cache\`（歌词和封面缓存）、`desktop.log`（原来黑窗口里显示的内容，出问题时看它）、`window.json`（窗口大小位置）、`webview\`（页面保存的设置）。删掉整个文件夹就是卸载。
- 页面的设置和浏览器版是分开保存的（两边不是同一个浏览器配置）。
- 体积小的原因：不带 Qt（LDDC 的界面库，215 MB，用 `server\qt_stub` 顶替）、不带 numpy（律动的滤波改成了纯 Python）、不带浏览器内核（用系统的）。
- LDDC 是 GPL-3.0，所以把这个压缩包发给别人时，整体要按 GPL-3.0 提供（附源码）。自己用不受影响。

## 基础安装和可选扩展

基础安装（`setup_base.bat`）只有几十 MB，就够用：页面、歌词库、导出视频、跟随播放器。更重的功能是**可选扩展**，要用再装，不用就不占空间：

| 扩展 | 安装脚本 | 大小 | 用来做什么 |
| --- | --- | --- | --- |
| 跟随播放器 | `setup_nowplaying.bat` | 几 MB | 读取电脑上正在播放的歌（QQ 音乐、网易云、酷狗等） |
| QQ / 酷狗 / 网易云歌词搜索 | `setup_lddc.bat` | 约 10 MB | 歌词库里搜逐字歌词；跟随播放器自动找歌词也靠它 |
| 自动识别（Whisper） | `setup_whisper.bat` | 0.6 到 1.7 GB | 没有歌词时，从音频识别出歌词。脚本里选 GPU（约 670 MB）或 CPU（21 MB）版，再选模型（turbo 574 MB / large-v3 1.08 GB） |
| 逐字对齐 | `setup_align.bat` | 约 1 GB + 模型 | 把 LRC 逐字对齐到音频。对齐模型第一次用时才下载：中文 1.2 GB、英文 360 MB |

没装的扩展，页面里的「自动识别」窗口会把对应选项置灰，并写明运行哪个脚本；装完后关掉 `start_server.bat` 的黑窗口再打开即可。

## 本地识别与对齐

- **识别**（没有歌词时）：whisper.cpp，有 NVIDIA 显卡时用 CUDA 版。由 `setup_whisper.bat` 下载程序和模型；模型文件放在 `models\`，也可以自己放别的 ggml 模型（认 `ggml-large-v3-q5_0.bin`、`ggml-large-v3.bin`、`ggml-large-v2-q5_0.bin`、`ggml-large-v3-turbo-q5_0.bin`）。
- **逐字对齐**（已有歌词时）：wav2vec2 强制对齐，中文、英文各自用对应的模型，第一次使用时自动下载到 `tools\hf-cache`。
- **歌词库**：AMLL TTML DB（社区逐词歌词）；运行过 `scripts\setup_lddc.bat` 后，还能搜 QQ 音乐 / 酷狗 / 网易云。
- 本地程序只监听本机 `127.0.0.1`，上传的音频临时放在 `tools\server-tmp`，下次启动时清空。

## 导出

MP4（H.264，可带 AAC 音频）、透明背景 MOV（PNG 编码）、PNG 序列 ZIP。可选尺寸、帧率、画质 / 防色带、编码速度和保存位置；导出时显示每帧耗时分析。

## 第三方

- [mp4-muxer](https://github.com/Vanilagy/mp4-muxer)（MIT），见 `web/vendor/mp4-muxer.LICENSE.txt`
- [whisper.cpp](https://github.com/ggerganov/whisper.cpp)（MIT），单独下载
- [LDDC](https://github.com/chenmozhijin/LDDC)（GPL-3.0），由 `setup_lddc.bat` 单独安装
- 字体：Archivo、Noto Sans SC、JetBrains Mono（SIL Open Font License 1.1）。字体文件放在 `web/fonts/`（来自 npm 的 @fontsource 包，即 Google Fonts 发布的版本），各自的许可证文本也在那个文件夹里（`*-OFL.txt`）。页面不再从网络加载字体，断网也能正常显示；单文件版只内置 Archivo 和 JetBrains Mono，中文用系统自带的中文字体。

## 许可证

Copyright (C) 2026 ZBZD-p

本项目以 [GNU General Public License v3.0](LICENSE)（GPL-3.0）发布：可以使用、修改和再发布（包括商用），但再发布的版本，包括修改后的版本，必须同样以 GPL-3.0 开源并附上源码。

## 免责声明

- 本项目仅供个人学习和研究使用。
- 「歌词库」「封面搜索」「跟随播放器」会访问第三方服务（AMLL TTML DB、QQ 音乐 / 酷狗 / 网易云等）或读取本机播放器的信息，这些接口不是官方提供的公开 API，随时可能变化或失效，也不保证可用。使用时请遵守这些服务各自的条款。
- 歌词和专辑封面的版权属于原作者和权利人。本仓库不包含任何受版权保护的歌词、音乐或封面；缓存只保存在你自己的电脑上（`tools\cache`）。
