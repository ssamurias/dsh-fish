/**
 * client.js —— 浏览器半边：对话里的播放器 + 设置页里的「语音」一节
 *
 * 播放器怎么进对话：宿主把 ```fish-voice 这段围栏交给 `conversation.chat.markdown.fence`
 * 这个 HOC 槽位，我们按 key 注册一个渲染器，把围栏内容换成 <audio controls>。
 * 所以工具只要回一行围栏文本，她原样放进回复里，对话里就有能点的播放器。
 *
 * 设置页：`settings.section` 里加一节「语音」，读写 `/dsh-fish-tts/config`。
 * 密钥只回 `***`，保存时原样回 `***` 表示「没改」——浏览器里永远看不到凭据原文。
 */
window.__ModuleLoader__.load({
  // 必须等于 package.json 的 name：client-modules 按 loader 条目名解析 bundle。
  id: 'dsh-fish-tts',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useState } = React

    // 子路径部署时（反代挂在 /app/...）站点绝对路径会 404；和 dsh-fish 一样先看注入值，
    // 再看 <base href>。
    const API = (() => {
      try {
        const injected = typeof window !== 'undefined' ? window.__DSH_BASE_PATH__ : undefined
        const base = injected || (typeof document !== 'undefined' && document.baseURI ? new URL(document.baseURI).pathname : '/')
        return `${String(base).replace(/\/+$/, '')}/dsh-fish-tts`
      } catch {
        return '/dsh-fish-tts'
      }
    })()

    const BOX = {
      border: '1px solid var(--dsw-alias-border-l4, #e3e3e3)',
      borderRadius: '10px',
      padding: '10px 12px',
      margin: '8px 0',
      background: 'var(--dsw-alias-bg-l1, #fafafa)',
    }
    const ROW = { display: 'flex', alignItems: 'center', gap: '8px', margin: '6px 0', flexWrap: 'wrap' }
    const INPUT = { padding: '5px 8px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l4, #d0d0d0)', minWidth: '180px', fontSize: '13px' }
    const LABEL = { fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #666)', minWidth: '92px' }
    const HINT = { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, #888)' }

    /** 围栏里的 JSON 解析失败时退回宿主默认的代码块，而不是整段消失。 */
    function VoiceFence(props) {
      const { code, children } = props || {}
      let data = null
      try { data = JSON.parse(String(code ?? '')) } catch { data = null }
      if (!data || typeof data.src !== 'string' || !data.src) return children ?? null
      return h('div', { style: BOX },
        data.text ? h('div', { style: { fontSize: '13px', marginBottom: '6px' } }, String(data.text)) : null,
        h('audio', {
          controls: true,
          preload: 'none',
          src: data.src,
          style: { width: '100%', maxWidth: '440px', display: 'block' },
        }),
        data.emotion ? h('div', { style: HINT }, `语气：${String(data.emotion)}`) : null)
    }

    function VoiceSection() {
      const [cfg, setCfg] = useState(null)
      const [voices, setVoices] = useState([])
      const [msg, setMsg] = useState('')
      const [busy, setBusy] = useState(false)
      const [why, setWhy] = useState('')

      const load = useCallback(async () => {
        try {
          const r = await fetch(`${API}/config`, { headers: { accept: 'application/json' } })
          // 404/空 body 时不要直接 r.json()：那会报「Unexpected end of JSON input」，
          // 看着像配置坏了，其实是路由没挂上（最常见的原因是装完插件没重启 DSH）。
          const text = await r.text()
          let j = null
          try { j = text ? JSON.parse(text) : null } catch { j = null }
          if (!r.ok || !j) {
            const hint = r.status === 404 ? '接口没挂上（404）——插件装好之后重启过 DSH 吗？' : `HTTP ${r.status}`
            throw new Error(j?.error || hint)
          }
          setCfg(j)
          setWhy(j.why || '')
        } catch (err) {
          setMsg(`读配置失败：${String(err?.message ?? err)}`)
        }
        try {
          const r = await fetch(`${API}/voices`, { headers: { accept: 'application/json' } })
          if (r.ok) {
            const j = await r.json()
            setVoices(Array.isArray(j?.voices) ? j.voices : [])
          }
        } catch { /* 没有音色列表也能填名字 */ }
      }, [])

      useEffect(() => { load() }, [load])

      const patch = (fn) => setCfg((c) => (c ? fn({ ...c, say: { ...c.say }, openai: { ...c.openai } }) : c))

      const save = async () => {
        if (!cfg || busy) return
        setBusy(true)
        setMsg('')
        try {
          const body = {
            provider: cfg.provider,
            say: { voice: cfg.say.voice, rate: Number(cfg.say.rate) },
            openai: {
              baseURL: cfg.openai.baseURL,
              model: cfg.openai.model,
              voice: cfg.openai.voice,
              apiKey: cfg.openai.apiKey,
              instructions: Boolean(cfg.openai.instructions),
            },
            maxChars: Number(cfg.maxChars),
          }
          const r = await fetch(`${API}/config`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
          const j = await r.json().catch(() => ({}))
          if (!r.ok) throw new Error(j?.error || `保存失败（${r.status}）`)
          setCfg(j)
          setWhy(j.why || '')
          setMsg('已保存，下一句话就按新配置说。')
        } catch (err) {
          setMsg(`保存失败：${String(err?.message ?? err)}`)
        } finally {
          setBusy(false)
        }
      }

      if (!cfg) {
        return h('div', null, h('p', { style: HINT }, msg || '正在读配置……'))
      }

      const cnVoices = voices.filter((v) => String(v.locale || '').startsWith('zh'))

      return h('div', null,
        h('p', { style: HINT }, '她说话用哪套嗓子、什么情绪怎么念。改完点保存，不用重启。'),
        why ? h('p', { style: { ...HINT, color: 'var(--dsw-alias-state-warning-primary, #b26a00)' } }, why) : null,

        h('div', { style: ROW },
          h('span', { style: LABEL }, '后端'),
          h('select', {
            style: INPUT,
            value: cfg.provider,
            onChange: (e) => patch((c) => ({ ...c, provider: e.target.value })),
          },
            h('option', { value: 'say' }, '本地 say（macOS，免配置）'),
            h('option', { value: 'openai' }, 'OpenAI 兼容接口（要密钥）'))),

        cfg.provider === 'say'
          ? h('div', null,
            h('div', { style: ROW },
              h('span', { style: LABEL }, '音色'),
              h('input', {
                style: INPUT, list: 'dsh-tts-voices', value: cfg.say.voice,
                placeholder: '如 Tingting、Eddy（中文（中国大陆））',
                onChange: (e) => patch((c) => ({ ...c, say: { ...c.say, voice: e.target.value } })),
              }),
              h('datalist', { id: 'dsh-tts-voices' }, cnVoices.map((v) => h('option', { key: v.name, value: v.name }, `${v.locale}`)))),
            h('div', { style: ROW },
              h('span', { style: LABEL }, '语速'),
              h('input', {
                style: { ...INPUT, minWidth: '90px' }, type: 'number', min: 90, max: 320, value: cfg.say.rate,
                onChange: (e) => patch((c) => ({ ...c, say: { ...c.say, rate: e.target.value } })),
              }),
              h('span', { style: HINT }, '词/分；情绪会在这个基础上再调')))
          : h('div', null,
            h('div', { style: ROW },
              h('span', { style: LABEL }, 'Base URL'),
              h('input', {
                style: { ...INPUT, minWidth: '300px' }, value: cfg.openai.baseURL,
                placeholder: 'https://api.openai.com/v1',
                onChange: (e) => patch((c) => ({ ...c, openai: { ...c.openai, baseURL: e.target.value } })),
              })),
            h('div', { style: ROW },
              h('span', { style: LABEL }, '模型'),
              h('input', {
                style: INPUT, value: cfg.openai.model,
                placeholder: 'gpt-4o-mini-tts',
                onChange: (e) => patch((c) => ({ ...c, openai: { ...c.openai, model: e.target.value } })),
              }),
              h('span', { style: LABEL }, '音色'),
              h('input', {
                style: INPUT, value: cfg.openai.voice,
                placeholder: 'alloy',
                onChange: (e) => patch((c) => ({ ...c, openai: { ...c.openai, voice: e.target.value } })),
              })),
            h('div', { style: ROW },
              h('span', { style: LABEL }, '密钥'),
              h('input', {
                style: { ...INPUT, minWidth: '300px' }, type: 'password', value: cfg.openai.apiKey,
                placeholder: cfg.hasKey ? '已保存（回 *** 表示不改）' : '还没填',
                onChange: (e) => patch((c) => ({ ...c, openai: { ...c.openai, apiKey: e.target.value } })),
              })),
            h('div', { style: ROW },
              h('label', { style: { ...HINT, display: 'flex', alignItems: 'center', gap: '6px' } },
                h('input', {
                  type: 'checkbox', checked: cfg.openai.instructions !== false,
                  onChange: (e) => patch((c) => ({ ...c, openai: { ...c.openai, instructions: e.target.checked } })),
                }),
                '把情绪写成一句发声指导（instructions，gpt-4o-mini-tts 这类模型认）'))),

        h('div', { style: ROW },
          h('span', { style: LABEL }, '一句最多'),
          h('input', {
            style: { ...INPUT, minWidth: '90px' }, type: 'number', min: 20, max: 1000, value: cfg.maxChars,
            onChange: (e) => patch((c) => ({ ...c, maxChars: e.target.value })),
          }),
          h('span', { style: HINT }, '字；超了工具会拒，不会硬念')),

        h('div', { style: ROW },
          h('button', { onClick: save, disabled: busy }, busy ? '保存中…' : '保存'),
          msg ? h('span', { style: HINT }, msg) : null),

        h('p', { style: HINT }, '情绪映射可以在 tts.json 的 emotions 里覆盖（比如让「温柔」更慢），默认十种。'),
        h('p', { style: HINT }, `数据目录：${cfg.root || ''}`))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => ctx.slots.inject('conversation.chat.markdown.fence', () => ctx.slots.register({
          name: 'conversation.chat.markdown.fence',
          key: 'fish-voice',
          id: 'dsh-fish-tts/fence/voice',
        }, VoiceFence), 'dsh-fish-tts: voice fence'), 'dsh-fish-tts: voice fence')

        ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'dsh-fish-tts',
          order: 7.5,
          label: () => '大肥鱼 · 语音',
        }, VoiceSection), 'dsh-fish-tts: settings section'), 'dsh-fish-tts: settings section')
      },
    }
  },
})
