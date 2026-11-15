# dsh-fish-tts

给 [dsh-fish](../../dsh-fish) 里的「大肥鱼」一套语音：工具 `her_micro` 按情绪合成语音，对话里出现能点的播放器。

## 她怎么用

调用 `her_micro({ text: '我在', emotion: '温柔' })`。工具回一行：

```fish-voice
{"src":"/dsh-fish-tts/audio/2026-11-13/v-….mp3","text":"我在","emotion":"温柔"}
```

把这一整行原样放进回复里，对话中就会出现播放器（`conversation.chat.markdown.fence` 槽位按 `fish-voice` 注册了渲染器）。不放进去，就只有她自己知道说过这句。

## 情绪中间层

工具只认「情绪名」，不认某一家平台的参数。`lib/emotion.js` 里十种情绪各自翻译：

| 情绪 | 本地 say | OpenAI 兼容 |
|---|---|---|
| 平静 | rate 180 / pbas 0 | speed 1 + 发声指导 |
| 温柔 | rate 160 / pbas -2 | speed 0.95 + 「放轻、放慢」 |
| 开心 | rate 205 / pbas +6 | speed 1.08 + 「轻快带笑」 |
| … | … | … |

可以在 `tts.json` 的 `emotions` 里按字段覆盖，加平台只需在情绪表里补一个字段。

## 配置

设置 → **大肥鱼 · 语音**（独立一节，排在大肥鱼设置后面），或直接改 `<数据目录>/tts.json`：

```json
{
  "provider": "say",
  "say": { "voice": "Tingting", "rate": 180 },
  "openai": { "baseURL": "https://api.openai.com/v1", "model": "gpt-4o-mini-tts", "voice": "alloy", "apiKey": "", "instructions": true },
  "maxChars": 500
}
```

- 文件权限 `0600`；`GET /dsh-fish-tts/config` 只回 `***` 与 `hasKey`，密钥不回浏览器。
- 保存走 `POST /dsh-fish-tts/config`，当场生效，不用重启。
- 本地 `say` 零配置（需 macOS + ffmpeg 转 mp3）；OpenAI 兼容接口填 baseURL/模型/音色/密钥即可。

## 会把什么发出去

**用本地 `say`（默认）：不出网。** 整句都由这台机器合成，没有任何请求离开本机。

**用 OpenAI 兼容接口：** 她把**要说的那句话**（`text`）连同情绪参数发到你配置的 `baseURL`。除此之外不发别的东西——不发事件流、不发日记、不发历史、不带头像或对话记录。也就是说：

- 只有她自己调 `her_micro` 时才会发；不是每句话都被自动送出去；
- 发到哪个端点完全由你的 `baseURL` 决定；
- 不想有任何外发，就把后端固定为 `say`（设置页「大肥鱼 · 语音」里选「本地 say」）。

## 密钥与产物放在哪

- 配置与密钥：`<数据目录>/tts.json`，权限 `0600`（只有当前用户能读）；浏览器侧永远只看到 `***`。
- 语音产物：`<数据目录>/voice/<日期>/v-<时间>-<哈希>.mp3`。这是**她的语音产物，不是她的状态**——插件不往 `events.jsonl`、`config.json`、`state.json`、身份文件里写任何东西。

## 边界

- 只读合成：不写她的事件流、不改她的配置、不进记忆。
- 语音文件落在 `<数据目录>/voice/<日期>/`，文件名带时间与内容哈希，不覆盖旧的。
- 路由 `/dsh-fish-tts/audio/<日期>/<文件>`，路径穿越有正则与目录前缀双重校验。
- 一次最多 `maxChars` 字（默认 500），超了工具直接拒，不会硬念。

## 装法

```sh
dsh plugin --profile desktop add "link:<这个目录>"
```

再把 `her_micro` 加进 dsh-fish 的 `config.json`：

```json
{ "tools": { "allow": ["her_micro"] } }
```

重启 DSH 一次（宿主侧路由与服务要重新装配），设置页刷新后出现「大肥鱼 · 语音」。

### 数据目录

插件包不写死任何本机路径。`root` 的取值顺序：插件配置 → `DSH_FISH_HOME` → `~/.dsh-fish`。

数据目录不在默认位置时，在自己的 **profile** 的 `cordis.patch.yml` 里覆盖（不要改插件包）：

```yaml
- id: fish-tts
  name: dsh-fish-tts
  config:
    root: <你的数据目录>
```

