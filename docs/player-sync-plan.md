# 「跟随播放器」功能：实现步骤书

> 说明：这是写功能时的规划，文中的 `js/xxx.js` 路径是当时的平铺结构。现在 `web/js` 已改成 ES module 并分了子目录（`core/`、`render/`、`background/`、`glass/`、`export/`、`ui/`、`player/`），对应关系见 README 的「web/js 各文件」。

目标：用户在 QQ 音乐、网易云音乐、酷狗等电脑客户端里放歌时，本项目的歌词页面自动识别正在播放的歌曲，自动下载逐字歌词，并按播放器的进度同步显示（包括暂停、拖动进度、切歌）。

本文写给接手实现的开发者或模型。请按阶段顺序做，**每个阶段结束都要能单独运行、单独验收**。阶段 1 的结果决定后面怎么做，不要跳过。

---

## 0. 先读懂项目（必读）

### 0.1 目录

```
lumilyric/
├─ start_server.bat          启动本地服务（tools\align-env 里的 Python）并打开 http://127.0.0.1:8765/
├─ web/                      页面（原生 JS，无构建步骤）
│  ├─ index.html             结构；底部按顺序 <script> 加载 js/*.js
│  ├─ style.css
│  └─ js/                    按加载顺序：core, lyrics, settings, view-dom, text-canvas, background,
│                            cover-extract, bloom, layout-scroll, layout-words, frame, export, sync,
│                            ui-effects, library, helper, glass, main
├─ server/
│  ├─ server.py              本地 HTTP 服务（ThreadingHTTPServer，仅监听 127.0.0.1）
│  ├─ lddc_bridge.py         通过 LDDC 搜索 / 下载 QQ音乐、酷狗、网易云 逐字歌词
│  └─ cover_search.py        封面搜索
├─ scripts/                  setup_align.bat（建 tools\align-env）、setup_lddc.bat、build_single.py 等
└─ tools/                    Python 虚拟环境 align-env 等（不进仓库）
```

所有 JS 文件都是普通脚本，共享全局作用域；后加载的文件可以用前面文件定义的函数和变量。

### 0.2 前端里和本功能有关的现有代码

| 位置 | 内容 |
| --- | --- |
| `js/lyrics.js` | `let audio = null, playing = false, base = 0, startPerf = 0, cur = null;` 播放状态 |
| `js/settings.js` | `now()`：当前播放时间（有 `audio` 用 `audio.currentTime`，否则用 `base + (performance.now() - startPerf)/1000`）<br>`total()`：总时长<br>`setPlaying(p)`、`seek(t)`<br>`lyricDelay` / `lt(t)`：歌词偏移（正数 = 歌词推迟） |
| `js/main.js` | `tick()`：每帧主循环，调用 `now()`、`total()`、`render()`，更新进度条和时间文字<br>`loadLRCText(text, name, note)`：载入 LRC 文本（成功返回 `true`，末尾会 `setTimeout(autoCoverAsk, 0)`）<br>`loadAudio(file)`、`$('status')` 状态栏文字 |
| `js/helper.js` | `helper`：本地服务状态（`/api/status` 的返回值，不在本地服务下打开时为 `null`）<br>`api(path, body, headers)`：POST 到本地服务，返回文本，出错抛 `Error`（带中文原因） |
| `js/library.js` | `lddcLoad(e)`：调用 `/api/lyrics/get` 后用 `loadLRCText` 载入，可参考 |
| `js/cover-extract.js` | `setCover(blob, label)`：设置封面（返回是否成功） |
| `js/ui-effects.js` | `autoCoverAsk()`：载入歌词后自动搜封面并弹窗询问（跟随模式下要跳过） |

### 0.3 后端现有接口（`server/server.py`）

- `GET /api/status` → `{ok, whisper, align, lddc, ...}`
- `POST /api/lyrics/search {q}` → `{items:[{token, source:"QQ音乐"|"酷狗"|"网易云", title, artist, album, duration(秒)}], errors}`
- `POST /api/lyrics/get {token}` → `{lrc, verbatim, translation, source, title}`（`lrc` 是逐字增强 LRC，页面能直接读）
- `POST /api/cover/search {q}`、`GET /api/cover/img?u=`
- 测试模式：环境变量 `LRC_SERVER_MOCK` 让识别 / 对齐返回假数据。新功能也要照这个习惯提供 mock。

### 0.4 约定

- 界面文字用中文，代码注释用英文，风格和现有文件保持一致（短函数、少依赖）。
- 不要引入前端框架或构建工具。
- 不要打包或下载任何受版权保护的歌曲。歌词只在运行时从平台获取，不存进仓库。
- 不要注入、修改或逆向播放器进程（不读内存、不 hook、不装播放器插件）。只用 Windows 公开的系统接口。
- 单文件版（`scripts/build_single.py` 生成的 `dist/lumilyric.html`）没有本地服务，这个功能在那里自动隐藏即可（`helper` 为 `null`）。

---

## 1. 原理

Windows 10/11 有「系统媒体传输控制」（System Media Transport Controls，SMTC）。播放器接入后，系统音量弹出框、锁屏会显示它的歌名和封面。任何程序都可以通过 WinRT 接口 `Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager` 读到：

- 每个会话的来源程序 ID：`session.source_app_user_model_id`
- 媒体信息：`await session.try_get_media_properties_async()` → `title`、`artist`、`album_title`、`thumbnail`（封面流）
- 时间线：`session.get_timeline_properties()` → `position`、`start_time`、`end_time`、`last_updated_time`
- 播放状态：`session.get_playback_info().playback_status`（PLAYING / PAUSED / STOPPED 等）
- 控制（可选）：`try_play_async()`、`try_pause_async()`、`try_skip_next_async()`、`try_change_playback_position_async()`

Python 里用 PyWinRT 的分模块包访问。**包名和导入路径请先到 PyPI 核实当前版本**，大致是：

```
pip install winrt-runtime winrt-Windows.Media.Control winrt-Windows.Foundation winrt-Windows.Storage.Streams
```

```python
from winrt.windows.media.control import GlobalSystemMediaTransportControlsSessionManager as SMTC
```

旧的 `winsdk` 包已停止维护，不要用。

**已知风险（必须在阶段 1 实测）：**

1. 不是每个播放器都接入了 SMTC，接入了也可能只给歌名不给进度。
2. 有的播放器只在暂停、拖动、切歌时更新 `position`，平时不更新。这时要用 `last_updated_time` 往前推算，或者自己用本地时钟推算。
3. `source_app_user_model_id` 的具体值（例如 `cloudmusic.exe`、`QQMusic.exe`）以实测为准，不要凭猜测写死。

---

## 阶段 1：探测脚本（先做，交给用户实测）

### 1.1 安装脚本 `scripts/setup_nowplaying.bat`

- 仿照 `scripts/setup_lddc.bat` 的写法：`cd /d "%~dp0.."`，用 `tools\align-env\Scripts\python.exe -m pip install ...` 装上面的 winrt 包。
- align-env 不存在时提示先运行 `scripts\setup_align.bat`。
- 装完打印「安装完成」，`pause`。

### 1.2 探测脚本 `scripts/probe_nowplaying.py` + `scripts/probe_nowplaying.bat`

- `.bat` 用 align-env 的 Python 运行 `.py`，设置 `PYTHONIOENCODING=utf-8`。
- `.py` 每 0.5 秒打印一次**所有**会话（不只是当前会话）：

```
12:03:04.512  [cloudmusic.exe]  PLAYING  晴天 - 周杰伦  (叶惠美)
              position=83.42s  end=269.00s  last_updated=12:03:01.002 (3.51s ago)  推算=86.93s
```

- 同时把每次读到的原始值追加写入 `tools\nowplaying-probe.log`，方便用户发回来。
- 打印当前会话 `manager.get_current_session()` 是哪个。
- 按 Ctrl+C 退出。
- 捕获所有异常并打印，不要因为某个会话出错就退出。

### 1.3 交给用户的测试清单（写进 README 或脚本开头的说明）

对网易云音乐、QQ 音乐、酷狗音乐分别：

1. 打开播放器放一首歌，运行 `probe_nowplaying.bat`。
2. 记录：有没有出现这个播放器？`source_app_user_model_id` 是什么？歌名、歌手对不对？
3. 不动它放 10 秒：`position` 有没有每次都变？`推算` 和播放器上显示的时间差多少？
4. 暂停、继续、拖动进度条、切下一首：状态和进度是否跟着变？延迟大概多少？

### 1.4 验收

脚本能在 Windows 上跑起来，用户填好下面这张表：

| 播放器 | 能检测到 | 程序 ID | 歌名歌手正确 | 进度持续更新 | 推算误差 | 暂停 / 拖动 / 切歌 |
| --- | --- | --- | --- | --- | --- | --- |
| 网易云音乐 | | | | | | |
| QQ 音乐 | | | | | | |
| 酷狗音乐 | | | | | | |

**如果三个播放器都检测不到，停在这里，向用户说明，不要继续。** 如果只是进度不更新，后面的阶段照做，靠推算补。

---

## 阶段 2：后端 `server/nowplaying.py` + 接口

### 2.1 模块 `server/nowplaying.py`

- 在一个后台守护线程里运行自己的 asyncio 事件循环，每 250 ms 读一次 SMTC，结果放进加锁的全局快照。
- 导入 winrt 失败（没装、不是 Windows）时 `available()` 返回 `False`，其他函数安全返回空结果，**不能让 server.py 启动失败**。
- 会话选择：
  1. 用户在页面上指定了程序 ID 时用它（见 2.3 的 `app` 参数）；
  2. 否则优先选正在 PLAYING 的会话，有多个时用 `get_current_session()`；
  3. 都没有就用 `get_current_session()`。
- 快照内容：

```json
{
  "ok": true,
  "app": "cloudmusic.exe",
  "appName": "网易云音乐",
  "title": "...", "artist": "...", "album": "...",
  "duration": 269.0,
  "position": 86.93,
  "playing": true,
  "at": 1760000000123,
  "trackId": "sha1(app|title|artist|album) 前 12 位",
  "sessions": [{"app": "...", "appName": "...", "title": "...", "playing": true}]
}
```

  - `position` 是**读取时刻**推算好的进度（秒）：播放中为 `position + (now_utc - last_updated_time)`，暂停时为 `position`。如果阶段 1 发现某播放器的 `last_updated_time` 不可靠，就自己记录「本地看到 position 变化的时刻」来推算，并按程序 ID 分别处理。
  - `at` 是服务端读取时刻的 Unix 毫秒时间戳（`time.time()*1000`）。页面和服务在同一台机器上，可以直接和 `Date.now()` 比较。
  - `duration` 取 `end_time - start_time`，拿不到时为 `0`。
  - `appName` 由程序 ID 映射成中文名（映射表放模块顶部，ID 用阶段 1 实测的值；未知 ID 原样显示）。
- 封面：歌曲变化时读一次 `thumbnail`（`open_read_async` 读成 bytes），缓存最新一张，记下 MIME 类型。

### 2.2 自动选歌词 `pick_lyrics(snapshot)`

放在 `nowplaying.py` 或 `lddc_bridge.py` 里，按 `trackId` 缓存结果（同一首歌只搜一次）：

1. 关键词：`title + " " + artist`。先清洗标题：去掉「(Live)」「（伴奏）」「- 电影《…》插曲」这类括号或后缀，但保留原标题用于打分。
2. 调 `LD.search_all(keyword)`。
3. 给每个结果打分（越高越好）：
   - 时长差 `|item.duration - duration|`：≤ 2 秒加 50 分，≤ 5 秒加 25 分，> 15 秒减 40 分（`duration` 为 0 时跳过这一项）；
   - 标题归一化（小写、去空格和标点、全角转半角、繁简不处理）后完全相同加 30 分，包含关系加 15 分；
   - 歌手有交集加 20 分；
   - 来源和播放器一致加 10 分（网易云音乐 → 「网易云」，QQ 音乐 → 「QQ音乐」，酷狗 → 「酷狗」）；
   - 下载后是逐字歌词（`verbatim`）再加 15 分。为了这一项，只对前 3 名调 `LD.get_lrc` 再排序，不要下载全部。
4. 返回 `{lrc, source, title, verbatim, score}`；最高分低于阈值（例如 40）时返回 `{"lrc": null, "reason": "没有找到匹配的歌词"}`。
5. LDDC 没装时返回 `{"lrc": null, "reason": "还没有安装 LDDC，先运行 scripts\\setup_lddc.bat"}`。

### 2.3 `server.py` 新接口

在 `do_GET` / `do_POST` 里按现有写法加：

- `GET /api/nowplaying?app=<可选程序ID>` → 2.1 的快照。不可用时返回 `{"ok": false, "reason": "..."}`（200，不要 500）。
- `GET /api/nowplaying/cover?track=<trackId>` → 封面图片字节；没有时 404。
- `POST /api/nowplaying/lyrics {trackId}` → 2.2 的结果。这一步较慢（联网），可以在 ThreadingHTTPServer 的请求线程里直接做。
- `POST /api/nowplaying/control {action: "play"|"pause"|"next"|"prev"|"seek", position?}` → `{ok}`。**可选**，放到阶段 5。
- `/api/status` 的返回里加 `"nowplaying": NP.available()`。
- 启动时打印一行状态，例如 `  player sync: on (SMTC)` 或 `  player sync: not installed (run scripts\setup_nowplaying.bat)`。

### 2.4 mock

环境变量 `LRC_NOWPLAYING_MOCK=1` 时，`nowplaying.py` 不导入 winrt，而是模拟一个会话：

- 固定歌名或歌手，从启动时开始计时；
- 每 40 秒自动「切歌」一次；
- 可以通过 `POST /api/nowplaying/control` 暂停或继续。

这样能在非 Windows 环境测试页面逻辑。

### 2.5 验收

- 用 mock 启动：`curl http://127.0.0.1:8765/api/nowplaying` 连续请求，`position` 正常增长；切歌时 `trackId` 变化。
- Windows 上真实播放器：接口返回的歌名、进度和阶段 1 的探测结果一致。
- 没装 winrt 时 server.py 照常启动，`/api/status` 里 `nowplaying: false`。

---

## 阶段 3：前端「跟随播放器」模式

新建 `web/js/follow.js`，在 `index.html` 里放在 `helper.js` 之后、`glass.js` 之前加载。

### 3.1 界面

- 底部按钮行（`index.html` 里「歌词库」按钮附近）加一个按钮 `#followBtn`「跟随播放器」，默认 `hidden`。`detectHelper()` 拿到 `helper.nowplaying === true` 时显示。
- 点击切换跟随模式，开启时按钮加 `on` 类（和现有 `.btn.on` 样式一致）。
- 开启后状态栏显示：`跟随：网易云音乐 · 歌名 - 歌手`，再加歌词来源（`· 歌词来自 QQ音乐（逐字）`）或原因（`· 没有找到匹配的歌词`）。
- 有多个会话时，在状态栏旁边给一个小下拉 `<select>` 选择跟随哪个程序（`sessions` 列表），选中的程序 ID 存进 `localStorage('lrc-follow-app')`，请求时作为 `app` 参数。
- 开关状态存进 `localStorage('lrc-follow')`，下次打开页面自动恢复（本地服务可用时）。

### 3.2 时间同步（核心）

- 每 300 ms 请求一次 `/api/nowplaying`（用 `fetch`，上一个请求没回来就不发下一个）。
- 维护本地状态 `F = {pos, at, playing, duration, trackId}`。
- 跟随时的当前时间：`F.playing ? F.pos + (Date.now() - F.at) / 1000 : F.pos`。
- **平滑**：收到新快照时，先算出新快照对应的此刻时间 `tNew`，再和当前显示的时间 `tCur` 比较：
  - `|tNew - tCur| > 0.35 秒`、播放状态变了、或者 `trackId` 变了：直接跳到新值（这是暂停、拖动、切歌）；
  - 否则不跳，用每秒最多 ±3% 的速度把显示时间慢慢拉向新值，避免歌词因为轮询抖动而前后跳。
- 接入方式：修改 `settings.js` 的 `now()`、`total()`，在最前面加：

```js
if (typeof followOn !== 'undefined' && followOn) return followNow();       // now()
if (typeof followOn !== 'undefined' && followOn) return followTotal();     // total()
```

  `followNow()` / `followTotal()` 在 `follow.js` 里定义。`settings.js` 比 `follow.js` 先加载，但这两个函数只在运行时调用，所以没问题。
- `playing` 变量要跟着播放器的状态更新：直接设 `playing = F.playing`，并更新播放按钮图标（参考 `setPlaying` 里改 `$('icon')` 的两行）。**不要调用 `setPlaying()`**，它会去操作 `audio`。
- 开启跟随时：如果载入了本地音频，先 `audio.pause()`，并把 `audio` 暂存起来、置为 `null`；关闭跟随时还原。这样 `now()` 等现有逻辑不会去读本地音频。
- 跟随时禁用页面上的播放按钮、进度条拖动、←/→ 快进快退（`main.js` 的键盘处理里加判断），或者在阶段 5 改成遥控播放器。
- `lyricDelay`（偏移）在跟随模式下照常生效，给用户手动修正播放器的固定延迟。可以考虑按程序 ID 分别记住偏移（`localStorage('lrc-follow-delay:' + app)`），切换跟随时自动套用。

### 3.3 切歌

`trackId` 变化时：

1. 状态栏显示「正在找歌词…」，清空当前歌词或保留上一首直到新歌词到达（建议显示一行「正在找《歌名》的歌词…」作为占位，可以用 `loadLRCText('[00:00.00]正在找《歌名》的歌词…', ...)`）。
2. `POST /api/nowplaying/lyrics {trackId}`。用序号丢弃过期的回应（用户快速切歌时）。
3. 拿到 `lrc` 后调 `loadLRCText(lrc, title + ' - ' + artist, note)`。**跟随模式下不要触发 `autoCoverAsk`**：在 `loadLRCText` 里改成 `if (!followOn) setTimeout(autoCoverAsk, 0);`（`loadTTMLText` 同样处理）。
4. 封面：`fetch('/api/nowplaying/cover?track=' + trackId)`，成功就 `setCover(blob, '播放器封面')`；失败时用 `/api/cover/search` 搜第一张（参考 `ui-effects.js` 的 `coverPick`）。
5. 没找到歌词时显示一行提示歌词（例如「没有找到《歌名》的歌词」），状态栏给出原因。

### 3.4 退出跟随

- 停止轮询，恢复本地音频（如果有），恢复按钮和键盘行为。
- 当前歌词保留，用户可以继续用本地方式播放或导出。

### 3.5 验收（用 mock 和真实播放器各做一遍）

- 开启后 1 秒内显示正确的歌和进度，歌词高亮和播放器听到的声音对得上（误差 < 0.3 秒，可以用偏移修正）。
- 暂停、继续、拖动进度：页面 0.5 秒内跟上。
- 切歌：3 秒内（取决于网络）换成新歌词和新封面。
- 连续快速切歌 5 次，最终显示的是最后一首。
- 关闭本地服务的黑窗口：页面不报错，状态栏提示「本地程序已断开」，自动退出跟随。
- 滚动歌词、逐词、单行三种布局，液态玻璃界面，都正常。
- 单文件版（`python scripts/build_single.py`）里看不到「跟随播放器」按钮，其他功能不受影响。

---

## 阶段 4：收尾

- `README.md`：在「快速开始」后面加一节「跟随播放器」，写清安装（`scripts\setup_nowplaying.bat`）、支持情况（阶段 1 的表）和偏移用法；文件夹表格和 `web/js` 表格加上新文件。
- `server.py` 顶部的 API 注释加上新接口。
- 实际测试过的播放器写进 README，没测过的不要声称支持。

---

## 阶段 5（可选）：遥控播放器

只有阶段 1 证明某播放器支持 SMTC 控制时才做：

- 跟随模式下，页面的播放 / 暂停按钮、空格键改为调用 `/api/nowplaying/control`。
- 进度条拖动改为 `seek`（很多播放器不支持 `try_change_playback_position_async`，返回 `False` 时状态栏提示「这个播放器不支持从这里拖动进度」）。
- 加「上一首」「下一首」按钮（只在跟随模式下显示）。

---

## 附：容易踩的坑

- winrt 的异步方法必须在 asyncio 事件循环里 `await`；不要在 HTTP 请求线程里新建事件循环，统一放在后台线程里。
- `position`、`end_time` 是 `datetime.timedelta`；`last_updated_time` 是带时区的 `datetime`，和 `datetime.now(timezone.utc)` 比较。注意旧版本可能返回 `0001-01-01` 这类无效时间，要判断。
- 有的播放器暂停后 `playback_status` 仍是 PLAYING 但 `position` 不动。可以用「position 连续 2 秒没变 → 视为暂停」兜底，但只对实测有这个问题的程序 ID 启用。
- 广告、播客、视频也会出现在 SMTC 里：`title` 为空或时长 < 30 秒时不要去搜歌词。
- 歌名可能带「(Live)」「(伴奏)」「- 电影…」等，搜索前清洗，但打分时也看原标题，避免把 Live 版对到录音室版上（时长差会帮忙区分）。
- 页面轮询失败（服务关了）时退避到 2 秒一次，连续失败 5 次再退出跟随，避免刷屏报错。
