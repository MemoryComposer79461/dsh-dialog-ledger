/**
 * dsh-dialog-ledger-v05 · V0.6 Client 半边（左栏面板 UI）
 *
 * 只读面板：左栏图标（sidebar.panellist）+ 主面板（main）。
 * 全部数据取自同源只读 HTTP API `/dialog-ledger/api/*`；本文件不做任何写操作，
 * 不直连文件系统、不猜路径、不追加 document.body 根节点、不读其它插件 DOM。
 *
 * 形态照 dsh-context 的既有写法：window.__ModuleLoader__.load + factory(require)
 * + React.createElement；零依赖（只 require('react')）、无构建、无 JSX。
 *
 * 注册（依据 docs/验收-v0.6/接口契约.md §2.3）：
 *   - sidebar.panellist id='dialog-ledger' order=25（图标，{size, active} → inline SVG）
 *   - main key='dialog-ledger'（主面板，四块：健康度 / 计数 / 检索 / 最近被查）
 *
 * TODO(v0.6.x)：语言热切换时面板文案的即时刷新尚未活体验证（label thunk 会重新取值，
 *   面板正文依赖下一次重渲染）；如实测不刷新，再接入 locale tick。
 */
window.__ModuleLoader__.load({
  id: 'dsh-dialog-ledger-v05',
  factory(require) {
    'use strict';

    const React = require('react');
    const h = React.createElement;
    const useState = React.useState;
    const useEffect = React.useEffect;
    const useCallback = React.useCallback;
    const useRef = React.useRef;
    const Fragment = React.Fragment;

    const PLUGIN_ID = 'dsh-dialog-ledger-v05';
    const NS = 'dialog-ledger';
    const API_PREFIX = '/dialog-ledger/api/';

    // ---------------------------------------------------------------------
    // 文案字典（flat key，与 dsh-context 一致：{en:{...}, zh:{...}}）
    // locale/en.json、locale/zh.json 只放 meta.title / meta.description，
    // 供 Plugin Manager 展示；面板正文用这里注册进 ctx.locale 的字典。
    // ---------------------------------------------------------------------
    const DICTS = {
      en: {
        'panel.title': 'Dialog ledger',
        'panel.rootLabel': 'Data root',
        'panel.layout': 'Layout v{v}',
        'panel.generatedAt': 'generated {at}',
        'action.refresh': 'Refresh',
        'action.reconcile': 'Reconcile now',
        'action.reconcileBusy': 'Reconciling…',
        'action.copyRoot': 'Copy data root path',
        'action.retry': 'Retry',
        'action.search': 'Search',
        'action.viewOriginal': 'View original',
        'action.hideOriginal': 'Hide original',
        'action.copyCode': 'Copy code',
        'action.copyPath': 'Copy path',
        'status.loading': 'Loading…',
        'status.pingReady': 'Read-only service ready',
        'status.pingDown': 'Read-only service not ready',
        'status.pingDownHint': 'Read-only service is not ready (check that the plugin is enabled)',
        'status.noData': 'No data',
        'status.copied': 'Copied',
        'status.copyFailed': 'Copy failed',
        'status.unknown': 'Unknown',
        'status.pass': 'Pass',
        'status.fail': 'Fail',
        'status.yes': 'Yes',
        'status.no': 'No',
        'section.health': '1 · Health',
        'section.counts': '2 · Counts',
        'section.search': '3 · Search',
        'section.reads': '4 · Recent reads',
        'health.badge.ok': 'Healthy',
        'health.badge.warn': 'Attention',
        'health.badge.bad': 'Failing',
        'health.badge.unverified': 'Unverified',
        'health.noRunReport': 'No run report',
        'health.evidence': 'Based on run report {at}',
        'health.lastRun': 'Last run: {at}',
        'health.metric.okStrict': 'Strict check',
        'health.metric.gate': 'Gate',
        'health.metric.readErrors': 'Ledger read errors',
        'health.metric.badLines': 'Bad lines',
        'health.metric.originalMissing': 'Missing originals',
        'health.metric.legacy': 'Legacy (unverifiable)',
        'health.metric.legacyUnmarked': 'Unmarked evidence-less',
        'health.metric.originalOrphan': 'Orphan originals',
        'health.metric.weeklyGroupsMissing': 'Missing weekly groups',
        'health.metric.lostGaps': 'Lost gaps',
        'health.metric.receiptBreaks': 'Receipt breaks',
        'health.metric.sealChain': 'Seal chain',
        'health.metric.blockedSources': 'Blocked sources',
        'health.metric.unavailable': 'Unavailable turns',
        'health.sealOk': 'OK',
        'health.sealBroken': 'Broken',
        'health.reconcileTitle': 'Reconcile',
        'health.reconcileRunning': 'Reconciling…',
        'health.reconcileDone': 'Reconciled · {at}',
        'health.reconcileWarn': 'Reconciled with issues · {at}',
        'health.reconcileFailed': 'Reconcile failed: {reason}',
        'health.reconcileStats': '{ledgerRows} ledger rows · {originalMissing} missing originals · {weeklyGroupsMissing} missing weekly groups · {receiptBreaks} receipt breaks',
        'counts.handover': 'Handover',
        'counts.handoverSub': 'Main {main} · Appendix {appendix}',
        'counts.original': 'Originals',
        'counts.originalSub': 'Views {views} · Attachments {attachments}',
        'counts.weekly': 'Weekly books',
        'counts.weeklySub': 'Files {files} · Sealed {sealed}',
        'counts.ledgerRows': 'Ledger rows',
        'search.sid': 'Session ID',
        'search.month': 'Month',
        'search.sidPlaceholder': 'Enter a session id',
        'search.idle': 'Enter a session id and month, then search',
        'search.empty': 'No matching rows (check the session id and month first)',
        'search.total': '{total} rows · scanned {scanned}',
        'search.truncated': 'truncated',
        'search.readErrors': 'read errors {n}',
        'search.loading': 'Searching…',
        'col.code': 'Code',
        'col.ts': 'Time',
        'col.turn': 'Turn',
        'col.status': 'Status',
        'col.original': 'Original',
        'original.unbound': 'unbound',
        'original.missing': 'missing original',
        'detail.code': 'Code',
        'detail.path': 'Original path',
        'detail.excerpt': 'Excerpt',
        'detail.excerptEmpty': '(no excerpt)',
        'detail.excerptTruncated': '… (truncated)',
        'detail.originalTitle': 'Original (read-only · {bytes} bytes)',
        'detail.originalTruncated': '… (truncated)',
        'reads.col.at': 'Time',
        'reads.col.tool': 'Tool',
        'reads.col.hitCodes': 'Hits',
        'reads.col.rows': 'Rows',
        'reads.col.ms': 'Duration',
        'reads.empty': 'No read records yet',
        'reads.summary': '{total} records · latest {at}',
        'reads.failed': 'failed',
        'reads.ms': '{n} ms',
        'error.request': 'Request failed: {message}',
        'error.pingFailed': 'Read-only service not ready',
        'error.pingFailedHint': 'Make sure the dialog-ledger plugin is enabled',
        'turn.loading': 'Loading details…',
      },
      zh: {
        'panel.title': '会话账本',
        'panel.rootLabel': '数据总库',
        'panel.layout': '布局 v{v}',
        'panel.generatedAt': '生成 {at}',
        'action.refresh': '刷新',
        'action.reconcile': '立即对账',
        'action.reconcileBusy': '对账中…',
        'action.copyRoot': '复制数据总库路径',
        'action.retry': '重试',
        'action.search': '检索',
        'action.viewOriginal': '查看原文',
        'action.hideOriginal': '收起原文',
        'action.copyCode': '复制编码',
        'action.copyPath': '复制路径',
        'status.loading': '加载中…',
        'status.pingReady': '只读服务已就绪',
        'status.pingDown': '只读服务未就绪',
        'status.pingDownHint': '只读服务未就绪（请确认插件已启用）',
        'status.noData': '暂无数据',
        'status.copied': '已复制',
        'status.copyFailed': '复制失败',
        'status.unknown': '未知',
        'status.pass': '通过',
        'status.fail': '未通过',
        'status.yes': '是',
        'status.no': '否',
        'section.health': '① 健康度',
        'section.counts': '② 计数',
        'section.search': '③ 检索',
        'section.reads': '④ 最近被查',
        'health.badge.ok': '正常',
        'health.badge.warn': '注意',
        'health.badge.bad': '异常',
        'health.badge.unverified': '未验证',
        'health.noRunReport': '无运行报告',
        'health.evidence': '依据：运行报告 {at}',
        'health.lastRun': '最近运行：{at}',
        'health.metric.okStrict': '严格校验',
        'health.metric.gate': '门禁',
        'health.metric.readErrors': '台账读错',
        'health.metric.badLines': '坏行',
        'health.metric.originalMissing': '缺凭证',
        'health.metric.legacy': '历史无证据',
        'health.metric.legacyUnmarked': '未标记无证据',
        'health.metric.originalOrphan': '孤儿凭证',
        'health.metric.weeklyGroupsMissing': '缺失周账组',
        'health.metric.lostGaps': '缺口',
        'health.metric.receiptBreaks': '收据断点',
        'health.metric.sealChain': '封板链',
        'health.metric.blockedSources': '阻塞源',
        'health.metric.unavailable': '未采段',
        'health.sealOk': '正常',
        'health.sealBroken': '断点',
        'health.reconcileTitle': '立即对账',
        'health.reconcileRunning': '对账中…',
        'health.reconcileDone': '对账完成 · {at}',
        'health.reconcileWarn': '对账完成（有异常） · {at}',
        'health.reconcileFailed': '对账失败：{reason}',
        'health.reconcileStats': '台账 {ledgerRows} 行 · 缺凭证 {originalMissing} · 周账缺组 {weeklyGroupsMissing} · 收据断点 {receiptBreaks}',
        'counts.handover': '交接表',
        'counts.handoverSub': '主表 {main} · 附表 {appendix}',
        'counts.original': '完整原文',
        'counts.originalSub': '视图 {views} · 附件 {attachments}',
        'counts.weekly': '周记账',
        'counts.weeklySub': '文件 {files} · 已封板 {sealed}',
        'counts.ledgerRows': '台账行数',
        'search.sid': 'Session ID',
        'search.month': '月份',
        'search.sidPlaceholder': '输入 Session ID',
        'search.idle': '输入 Session ID 与月份后开始检索',
        'search.empty': '无匹配行（先确认 Session ID 与月份）',
        'search.total': '共 {total} 行 · 扫描 {scanned}',
        'search.truncated': '已截断',
        'search.readErrors': '读错 {n}',
        'search.loading': '检索中…',
        'col.code': '编码',
        'col.ts': '时间',
        'col.turn': '轮次',
        'col.status': '状态',
        'col.original': '原文',
        'original.unbound': '未绑定',
        'original.missing': '原文缺失',
        'detail.code': '编码',
        'detail.path': '原文路径',
        'detail.excerpt': '开头片段',
        'detail.excerptEmpty': '（excerpt 为空）',
        'detail.excerptTruncated': '…（已截断）',
        'detail.originalTitle': '原文（只读 · {bytes} 字节）',
        'detail.originalTruncated': '…（已截断）',
        'reads.col.at': '时间',
        'reads.col.tool': '工具',
        'reads.col.hitCodes': '命中编码',
        'reads.col.rows': '返回行数',
        'reads.col.ms': '耗时',
        'reads.empty': '尚无读记录',
        'reads.summary': '共 {total} 条 · 最近 {at}',
        'reads.failed': '失败',
        'reads.ms': '{n} ms',
        'error.request': '请求失败：{message}',
        'error.pingFailed': '只读服务未就绪',
        'error.pingFailedHint': '请确认 dialog-ledger 插件已启用',
        'turn.loading': '详情加载中…',
      },
    };

    // ---------------------------------------------------------------------
    // 工具函数（纯函数，无副作用）
    // ---------------------------------------------------------------------

    /** 同源只读 GET；HTTP 非 2xx 抛错，200 + ok:false 交由调用方渲染 reason。 */
    function apiGet(route, params) {
      const search = new URLSearchParams();
      if (params && typeof params === 'object') {
        for (const key of Object.keys(params)) {
          const value = params[key];
          if (value === undefined || value === null || value === '') continue;
          search.set(key, String(value));
        }
      }
      const query = search.toString();
      const url = API_PREFIX + route + (query === '' ? '' : '?' + query);
      return fetch(url, {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      }).then(function (response) {
        return response.json().catch(function () {
          return null;
        }).then(function (body) {
          if (!response.ok) {
            if (body && typeof body === 'object' && typeof body.reason === 'string' && body.reason !== '') {
              const detail = typeof body.detail === 'string' && body.detail !== '' ? ': ' + body.detail : '';
              throw new Error(body.reason + detail);
            }
            throw new Error('HTTP ' + response.status);
          }
          if (body === null) throw new Error('invalid JSON response');
          return body;
        });
      });
    }

    /** 本地兜底复制（navigator.clipboard 不可用时），只在用户点击时执行。 */
    function fallbackCopy(text) {
      return new Promise(function (resolve, reject) {
        try {
          const area = document.createElement('textarea');
          area.value = String(text);
          area.setAttribute('readonly', '');
          area.style.position = 'fixed';
          area.style.top = '0';
          area.style.left = '0';
          area.style.opacity = '0';
          document.body.appendChild(area);
          area.select();
          const ok = typeof document.execCommand === 'function' ? document.execCommand('copy') : false;
          if (area.parentNode !== null) area.parentNode.removeChild(area);
          if (ok) resolve();
          else reject(new Error('copy failed'));
        } catch (err) {
          reject(err);
        }
      });
    }

    /** 只在路径两端保留，避免表格被长路径撑爆。 */
    function shortPath(value) {
      if (typeof value !== 'string' || value === '') return '';
      const parts = value.split(/[\\/]/).filter(function (part) {
        return part !== '';
      });
      if (parts.length <= 2) return value;
      return '…/' + parts.slice(-2).join('/');
    }

    // ---------------------------------------------------------------------
    // 左栏图标：账本（封面 + 书脊 + 记账行 + 校验勾），随侧栏 currentColor。
    // 收到 {size, active}，无副作用。
    // ---------------------------------------------------------------------
    function LedgerIcon(props) {
      const size = props && typeof props.size === 'number' && isFinite(props.size) ? props.size : 18;
      const active = Boolean(props && props.active);
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          'aria-hidden': true,
          focusable: 'false',
          style: { display: 'block', opacity: active ? 1 : 0.85 },
        },
        h('rect', {
          x: 3.75,
          y: 2.75,
          width: 16.5,
          height: 18.5,
          rx: 2.6,
          strokeWidth: active ? 1.7 : 1.5,
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M8.25 2.75v18.5',
          strokeWidth: active ? 1.7 : 1.5,
          strokeLinecap: 'round',
        }),
        h('path', {
          d: 'M11.3 7.4h5.6M11.3 10.9h5.6M11.3 14.4h3.6',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          opacity: 0.65,
        }),
        h('path', {
          d: 'M13.7 18.6l1.4 1.4 2.8-3.1',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        })
      );
    }

    // ---------------------------------------------------------------------
    // 主面板
    // ---------------------------------------------------------------------
    function makeLedgerPanel(t) {
      function reasonOf(data) {
        if (data && typeof data.reason === 'string' && data.reason !== '') {
          return typeof data.detail === 'string' && data.detail !== ''
            ? data.reason + ': ' + data.detail
            : data.reason;
        }
        return t('status.unknown');
      }

      function messageOf(err) {
        if (err && typeof err.message === 'string' && err.message !== '') return err.message;
        return t('status.unknown');
      }

      function numText(value) {
        if (typeof value === 'number' && isFinite(value)) return String(value);
        return '—';
      }

      function sumText(a, b) {
        if (typeof a === 'number' && isFinite(a) && typeof b === 'number' && isFinite(b)) return String(a + b);
        return '—';
      }

      function countTone(value) {
        if (typeof value !== 'number' || !isFinite(value)) return 'idle';
        return value > 0 ? 'bad' : 'ok';
      }

      function triTone(value) {
        if (value === true) return 'ok';
        if (value === false) return 'bad';
        return 'idle';
      }

      function triText(value, yes, no) {
        if (value === true) return yes;
        if (value === false) return no;
        return '—';
      }

      function healthBadge(health) {
        if (health === null || typeof health !== 'object') {
          return { tone: 'idle', text: t('health.badge.unverified') };
        }
        if (health.ok === null || health.ok === undefined) {
          return { tone: 'idle', text: t('health.badge.unverified') };
        }
        if (health.ok === false) return { tone: 'bad', text: t('health.badge.bad') };
        if (health.okStrict === false) return { tone: 'warn', text: t('health.badge.warn') };
        if (typeof health.errors === 'number' && health.errors > 0) {
          return { tone: 'warn', text: t('health.badge.warn') };
        }
        return { tone: 'ok', text: t('health.badge.ok') };
      }

      function rowStatusTone(status) {
        if (typeof status !== 'string') return 'idle';
        const normalized = status.toLowerCase();
        if (normalized === 'ok' || normalized === 'sealed' || normalized === 'closed') return 'ok';
        if (normalized === 'error' || normalized === 'bad' || normalized === 'fail' || normalized === 'failed') return 'bad';
        return 'idle';
      }

      function gateTone(gate) {
        // ★ V0.6.1 三级闸门：ok=无保留（绿）/ degraded=有保留（黄）/ unknown=无法表示意见（灰）
        if (gate === 'degraded') return 'warn';
        if (gate === 'pass' || gate === 'ok' || gate === 'green') return 'ok';
        if (gate === 'block' || gate === 'blocked' || gate === 'fail' || gate === 'red') return 'bad';
        return 'idle';
      }

      /**
       * 把「完整原文」按行渲染成结构化节点（V0.6.4：用户/Agent 对话**粗体**）。
       *
       * @why 原文是逐字文本（不许改写），但整段式 <pre> 里对话与元数据混在一起，
       *      翻查时眼睛很累。这里只做**呈现层分组**，文本一个字符不改：
       *        · front matter / `>` 声明 / `[seq …]` → 弱化（meta）
       *        · `## N. user/message|assistant/message` 及 `## …` 标题 → 标题样式
       *        · 对话节内正文（代码围栏与表格除外）→ **粗体**；
       *        · 代码围栏内保持等宽常规（粗体会影响代码可读性）。
       *      text 原样放进文本节点 → React 自动转义，无注入风险。
       */
      function renderOriginalLines(text, truncatedLabel, truncated) {        const lines = String(text === null || text === undefined ? '' : text).split('\n');
        const out = [];
        let front = 0; // 0=未进入 front matter，1=在 front matter 内，2=已结束
        let dialog = false; // 当前节是否为用户/助手对话
        let fence = false; // 是否在 ``` 代码围栏内
        for (let i = 0; i < lines.length; i += 1) {
          const line = lines[i];
          let cls = 'dl-orig-line';
          if (front < 2 && /^---\s*$/.test(line)) {
            front = front === 0 ? 1 : 2;
            cls += ' dl-orig-meta';
          } else if (front === 1) {
            cls += ' dl-orig-meta';
          } else if (/^##\s+\d+\.\s+/.test(line)) {
            const sec = line.replace(/^##\s+\d+\.\s+/, '').trim();
            dialog = sec === 'user/message' || sec === 'assistant/message';
            cls += ' dl-orig-head';
          } else if (/^#{1,6}\s/.test(line)) {
            cls += ' dl-orig-head';
          } else if (/^>\s?/.test(line) || /^\[seq\s/.test(line)) {
            cls += ' dl-orig-meta';
          } else if (/^```/.test(line)) {
            fence = !fence;
            cls += ' dl-orig-code';
          } else if (fence) {
            cls += ' dl-orig-code';
          } else if (dialog && line.trim() !== '') {
            cls += ' dl-orig-dialog';
          }
          out.push(h('div', { className: cls, key: 'ol' + i }, line === '' ? '\u00A0' : line));
        }
        if (truncated) out.push(h('div', { className: 'dl-orig-meta', key: 'ol-trunc' }, truncatedLabel));
        return out;
      }

      function stateLine(text, extraClass) {
        return h('div', { className: 'dl-state' + (extraClass ? ' ' + extraClass : '') }, text);
      }

      function errorLine(message, onRetry) {
        return h(
          'div',
          { className: 'dl-state dl-state-error', role: 'alert' },
          h('span', null, t('error.request', { message: message })),
          typeof onRetry === 'function'
            ? h('button', { type: 'button', className: 'dl-btn dl-btn-sm', onClick: onRetry }, t('action.retry'))
            : null
        );
      }

      function cardHead(title, note, extra) {
        return h(
          'div',
          { className: 'dl-card-head' },
          h('h2', { className: 'dl-card-title' }, title),
          note !== null && note !== undefined && note !== ''
            ? h('span', { className: 'dl-card-note' }, note)
            : null,
          extra ? h('div', { className: 'dl-card-head-right' }, extra) : null
        );
      }

      function LedgerPanel() {
        const [ping, setPing] = useState({ state: 'loading' });
        const [summary, setSummary] = useState({ state: 'loading' });
        const [reads, setReads] = useState({ state: 'loading' });
        const [reconcile, setReconcile] = useState({ state: 'idle' });
        const [sid, setSid] = useState('');
        const [month, setMonth] = useState('');
        const [search, setSearch] = useState({ state: 'idle' });
        const [expanded, setExpanded] = useState(null);
        const [flash, setFlash] = useState(null);

        const alive = useRef(true);
        const flashTimer = useRef(null);

        useEffect(function () {
          alive.current = true;
          return function () {
            alive.current = false;
            if (flashTimer.current !== null) {
              clearTimeout(flashTimer.current);
              flashTimer.current = null;
            }
          };
        }, []);

        useEffect(function () {
          if (flash === null) return undefined;
          if (flashTimer.current !== null) clearTimeout(flashTimer.current);
          flashTimer.current = setTimeout(function () {
            if (alive.current) setFlash(null);
          }, 2000);
          return function () {
            if (flashTimer.current !== null) {
              clearTimeout(flashTimer.current);
              flashTimer.current = null;
            }
          };
        }, [flash]);

        const loadPing = useCallback(async function () {
          setPing({ state: 'loading' });
          try {
            const data = await apiGet('ping');
            if (!alive.current) return;
            if (!data || data.ok === false) {
              setPing({ state: 'error', reason: reasonOf(data) });
              return;
            }
            setPing({ state: 'ready', data: data });
          } catch (err) {
            if (alive.current) setPing({ state: 'error', reason: messageOf(err) });
          }
        }, []);

        const loadSummary = useCallback(async function () {
          setSummary({ state: 'loading' });
          try {
            const data = await apiGet('summary');
            if (!alive.current) return;
            if (!data || data.ok === false) {
              setSummary({ state: 'error', reason: reasonOf(data) });
              return;
            }
            setSummary({ state: 'ready', data: data });
          } catch (err) {
            if (alive.current) setSummary({ state: 'error', reason: messageOf(err) });
          }
        }, []);

        const loadReads = useCallback(async function () {
          setReads({ state: 'loading' });
          try {
            const data = await apiGet('reads', { limit: 20 });
            if (!alive.current) return;
            if (!data || data.ok === false) {
              setReads({ state: 'error', reason: reasonOf(data) });
              return;
            }
            setReads({ state: 'ready', data: data });
          } catch (err) {
            if (alive.current) setReads({ state: 'error', reason: messageOf(err) });
          }
        }, []);

        const loadAll = useCallback(function () {
          loadPing();
          loadSummary();
          loadReads();
        }, [loadPing, loadSummary, loadReads]);

        useEffect(function () {
          loadAll();
        }, [loadAll]);

        const copy = useCallback(function (label, text) {
          const value = text === null || text === undefined ? '' : String(text);
          if (value === '') {
            setFlash({ kind: 'bad', text: t('status.copyFailed') });
            return;
          }
          let task;
          try {
            if (
              typeof navigator !== 'undefined' &&
              navigator.clipboard &&
              typeof navigator.clipboard.writeText === 'function'
            ) {
              task = navigator.clipboard.writeText(value);
            } else {
              task = fallbackCopy(value);
            }
          } catch (err) {
            task = Promise.reject(err);
          }
          Promise.resolve(task).then(
            function () {
              if (alive.current) setFlash({ kind: 'ok', text: t('status.copied') + ' · ' + label });
            },
            function () {
              if (alive.current) setFlash({ kind: 'bad', text: t('status.copyFailed') });
            }
          );
        }, []);

        const runReconcile = useCallback(async function () {
          setReconcile({ state: 'loading' });
          try {
            const data = await apiGet('reconcile', { refresh: 1, maxDetail: 50 });
            if (!alive.current) return;
            if (!data || data.ok === false) {
              setReconcile({ state: 'error', reason: reasonOf(data) });
              return;
            }
            setReconcile({ state: 'ready', data: data });
          } catch (err) {
            if (alive.current) setReconcile({ state: 'error', reason: messageOf(err) });
          }
        }, []);

        const runSearch = useCallback(async function (event) {
          if (event && typeof event.preventDefault === 'function') event.preventDefault();
          const sidValue = sid.trim();
          const monthValue = month.trim();
          if (sidValue === '' && monthValue === '') {
            setSearch({ state: 'idle' });
            setExpanded(null);
            return;
          }
          setSearch({ state: 'loading' });
          setExpanded(null);
          const params = { limit: 100 };
          if (sidValue !== '') params.sid = sidValue;
          if (monthValue !== '') params.month = monthValue;
          try {
            const data = await apiGet('search', params);
            if (!alive.current) return;
            if (!data || data.ok === false) {
              setSearch({ state: 'error', reason: reasonOf(data) });
              return;
            }
            if (!Array.isArray(data.rows) || data.rows.length === 0) {
              setSearch({ state: 'empty', data: data });
              return;
            }
            setSearch({ state: 'ready', data: data });
          } catch (err) {
            if (alive.current) setSearch({ state: 'error', reason: messageOf(err) });
          }
        }, [sid, month]);

        const toggleRow = useCallback(function (row) {
          if (!row || typeof row.code !== 'string' || row.code === '') return;
          setExpanded(function (previous) {
            if (previous !== null && previous.code === row.code) return null;
            return { code: row.code, row: row, state: 'loading' };
          });
        }, []);

        useEffect(function () {
          if (expanded === null || expanded.state !== 'loading') return undefined;
          const code = expanded.code;
          let cancelled = false;
          apiGet('turn', { code: code, excerptBytes: 1200 }).then(
            function (data) {
              if (cancelled || !alive.current) return;
              setExpanded(function (previous) {
                if (previous === null || previous.code !== code) return previous;
                if (!data || data.ok === false) {
                  return { ...previous, state: 'error', reason: reasonOf(data) };
                }
                return { ...previous, state: 'ready', data: data };
              });
            },
            function (err) {
              if (cancelled || !alive.current) return;
              setExpanded(function (previous) {
                if (previous === null || previous.code !== code) return previous;
                return { ...previous, state: 'error', reason: messageOf(err) };
              });
            }
          );
          return function () {
            cancelled = true;
          };
        }, [expanded === null ? null : expanded.code, expanded === null ? null : expanded.state]);

        const viewOriginal = useCallback(function (code) {
          if (typeof code !== 'string' || code === '') return;
          setExpanded(function (previous) {
            if (previous === null || previous.code !== code) return previous;
            return { ...previous, originalState: 'loading' };
          });
          apiGet('original', { code: code, maxBytes: 131072 }).then(
            function (data) {
              if (!alive.current) return;
              setExpanded(function (previous) {
                if (previous === null || previous.code !== code) return previous;
                if (!data || data.ok === false) {
                  return { ...previous, originalState: 'error', originalReason: reasonOf(data) };
                }
                return { ...previous, originalState: 'ready', original: data };
              });
            },
            function (err) {
              if (!alive.current) return;
              setExpanded(function (previous) {
                if (previous === null || previous.code !== code) return previous;
                return { ...previous, originalState: 'error', originalReason: messageOf(err) };
              });
            }
          );
        }, []);

        const hideOriginal = useCallback(function (code) {
          setExpanded(function (previous) {
            if (previous === null || previous.code !== code) return previous;
            return { ...previous, originalState: 'idle', original: null, originalReason: null };
          });
        }, []);

        // ---- 派生展示值 ----
        const pingReady = ping.state === 'ready' && ping.data !== null && ping.data.ok !== false;
        const summaryData = summary.state === 'ready' ? summary.data : null;
        const health = summaryData && summaryData.health && typeof summaryData.health === 'object'
          ? summaryData.health
          : null;
        const rootPath = summaryData && typeof summaryData.root === 'string' && summaryData.root !== ''
          ? summaryData.root
          : ping.state === 'ready' && ping.data && typeof ping.data.root === 'string'
            ? ping.data.root
            : '';
        const layoutVersion = summaryData && summaryData.layoutVersion !== null && summaryData.layoutVersion !== undefined
          ? summaryData.layoutVersion
          : null;
        const generatedAt = summaryData && typeof summaryData.generatedAt === 'string' && summaryData.generatedAt !== ''
          ? summaryData.generatedAt
          : '';

        // ---- 顶栏 ----
        function renderTop() {
          const pingChip = pingReady
            ? h('span', { className: 'dl-ping dl-tone-ok' }, h('span', { className: 'dl-dot' }), t('status.pingReady'))
            : ping.state === 'loading'
              ? h('span', { className: 'dl-ping dl-tone-idle' }, h('span', { className: 'dl-dot' }), t('status.loading'))
              : h('span', { className: 'dl-ping dl-tone-bad' }, h('span', { className: 'dl-dot' }), t('status.pingDown'));

          const subParts = [];
          if (rootPath !== '') {
            subParts.push(h('span', { className: 'dl-sub-label' }, t('panel.rootLabel')));
            subParts.push(h('code', { className: 'dl-mono dl-root', title: rootPath }, rootPath));
          }
          if (layoutVersion !== null) {
            subParts.push(h('span', { className: 'dl-sub-sep' }, '·'));
            subParts.push(h('span', { className: 'dl-sub-label' }, t('panel.layout', { v: String(layoutVersion) })));
          }
          if (generatedAt !== '') {
            subParts.push(h('span', { className: 'dl-sub-sep' }, '·'));
            subParts.push(h('span', { className: 'dl-sub-label' }, t('panel.generatedAt', { at: generatedAt })));
          }

          return h(
            'header',
            { className: 'dl-top' },
            h(
              'div',
              { className: 'dl-top-main' },
              h(
                'div',
                { className: 'dl-title-row' },
                h('h1', { className: 'dl-title' }, t('panel.title')),
                pingChip
              ),
              subParts.length > 0 ? h('div', { className: 'dl-sub' }, subParts) : null
            ),
            h(
              'div',
              { className: 'dl-actions' },
              h(
                'button',
                { type: 'button', className: 'dl-btn', onClick: loadAll },
                t('action.refresh')
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dl-btn dl-btn-primary',
                  onClick: runReconcile,
                  disabled: reconcile.state === 'loading',
                },
                reconcile.state === 'loading' ? t('action.reconcileBusy') : t('action.reconcile')
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dl-btn',
                  onClick: function () {
                    copy(t('action.copyRoot'), rootPath);
                  },
                  disabled: rootPath === '',
                },
                t('action.copyRoot')
              )
            )
          );
        }

        // ---- ① 健康度（第一屏） ----
        function renderHealthCard() {
          const headExtra = health !== null
            ? h('span', { className: 'dl-badge dl-tone-' + healthBadge(health).tone }, healthBadge(health).text)
            : null;

          if (summary.state === 'loading') {
            return h(
              'section',
              { className: 'dl-card dl-card-health' },
              cardHead(t('section.health'), null, headExtra),
              h('div', { className: 'dl-state dl-state-loading' }, t('status.loading'))
            );
          }
          if (summary.state === 'error') {
            return h(
              'section',
              { className: 'dl-card dl-card-health' },
              cardHead(t('section.health'), null, headExtra),
              errorLine(summary.reason, loadSummary)
            );
          }

          const metrics = [];
          if (health !== null) {
            metrics.push({
              key: 'okStrict',
              label: t('health.metric.okStrict'),
              value: triText(health.okStrict, t('status.pass'), t('status.fail')),
              tone: triTone(health.okStrict),
            });
            metrics.push({
              key: 'gate',
              label: t('health.metric.gate'),
              value: health.gate === null || health.gate === undefined || health.gate === '' ? '—' : String(health.gate),
              tone: gateTone(health.gate),
            });
            metrics.push({ key: 'readErrors', label: t('health.metric.readErrors'), value: numText(health.readErrors), tone: countTone(health.readErrors) });
            metrics.push({ key: 'badLines', label: t('health.metric.badLines'), value: numText(health.badLines), tone: countTone(health.badLines) });
            metrics.push({ key: 'originalMissing', label: t('health.metric.originalMissing'), value: numText(health.originalMissing), tone: countTone(health.originalMissing) });
            // ★ V0.6 / D18：历史无证据（已基线标记，不计缺）与"未标记无证据"（按缺凭证计）分开显示
            metrics.push({ key: 'legacyUnverifiable', label: t('health.metric.legacy'), value: numText(health.legacyUnverifiable), tone: countTone(health.legacyUnverifiable) });
            metrics.push({ key: 'legacyUnmarkedNoEvidence', label: t('health.metric.legacyUnmarked'), value: numText(health.legacyUnmarkedNoEvidence), tone: countTone(health.legacyUnmarkedNoEvidence) });
            metrics.push({ key: 'originalOrphan', label: t('health.metric.originalOrphan'), value: numText(health.originalOrphan), tone: countTone(health.originalOrphan) });
            metrics.push({ key: 'weeklyGroupsMissing', label: t('health.metric.weeklyGroupsMissing'), value: numText(health.weeklyGroupsMissing), tone: countTone(health.weeklyGroupsMissing) });
            metrics.push({ key: 'lostGaps', label: t('health.metric.lostGaps'), value: numText(health.lostGaps), tone: countTone(health.lostGaps) });
            metrics.push({ key: 'receiptBreaks', label: t('health.metric.receiptBreaks'), value: numText(health.receiptBreaks), tone: countTone(health.receiptBreaks) });
            metrics.push({
              key: 'sealChain',
              label: t('health.metric.sealChain'),
              value: triText(health.sealChainOk, t('health.sealOk'), t('health.sealBroken')),
              tone: triTone(health.sealChainOk),
            });
            metrics.push({ key: 'blockedSources', label: t('health.metric.blockedSources'), value: numText(health.blockedSources), tone: countTone(health.blockedSources) });
            metrics.push({ key: 'unavailable', label: t('health.metric.unavailable'), value: numText(health.unavailable), tone: countTone(health.unavailable) });
          }

          const evidenceText = health === null
            ? t('health.noRunReport')
            : health.evidence === 'no-run-report'
              ? t('health.noRunReport')
              : typeof health.lastRunReportAt === 'string' && health.lastRunReportAt !== ''
                ? t('health.evidence', { at: health.lastRunReportAt })
                : t('health.noRunReport');

          const reconcileLine = (function () {
            if (reconcile.state === 'idle') return null;
            if (reconcile.state === 'loading') {
              return h(
                'div',
                { className: 'dl-reconcile' },
                h('span', { className: 'dl-reconcile-title' }, t('health.reconcileTitle')),
                h('span', { className: 'dl-state dl-state-loading' }, t('health.reconcileRunning'))
              );
            }
            if (reconcile.state === 'error') {
              return h(
                'div',
                { className: 'dl-reconcile', role: 'alert' },
                h('span', { className: 'dl-reconcile-title dl-tone-bad' }, t('health.reconcileFailed', { reason: reconcile.reason || t('status.unknown') }))
              );
            }
            const data = reconcile.data || {};
            const at = typeof data.at === 'string' && data.at !== '' ? data.at : '—';
            const hasIssue =
              data.okStrict === false ||
              data.ledgerOk === false ||
              (typeof data.originalMissingCount === 'number' && data.originalMissingCount > 0) ||
              (typeof data.weeklyGroupsMissingCount === 'number' && data.weeklyGroupsMissingCount > 0) ||
              (typeof data.receiptBreaksCount === 'number' && data.receiptBreaksCount > 0);
            return h(
              'div',
              { className: 'dl-reconcile' },
              h(
                'span',
                { className: 'dl-reconcile-title ' + (hasIssue ? 'dl-tone-warn' : 'dl-tone-ok') },
                hasIssue ? t('health.reconcileWarn', { at: at }) : t('health.reconcileDone', { at: at })
              ),
              h(
                'span',
                { className: 'dl-card-note' },
                t('health.reconcileStats', {
                  ledgerRows: numText(data.ledgerRows),
                  originalMissing: numText(data.originalMissingCount),
                  weeklyGroupsMissing: numText(data.weeklyGroupsMissingCount),
                  receiptBreaks: numText(data.receiptBreaksCount),
                })
              )
            );
          })();

          return h(
            'section',
            { className: 'dl-card dl-card-health' },
            cardHead(t('section.health'), null, headExtra),
            metrics.length > 0
              ? h(
                  'div',
                  { className: 'dl-metrics' },
                  metrics.map(function (metric) {
                    return h(
                      'div',
                      { className: 'dl-metric', key: metric.key },
                      h('div', { className: 'dl-metric-label', title: metric.label }, metric.label),
                      h('div', { className: 'dl-metric-value dl-tone-' + metric.tone }, metric.value)
                    );
                  })
                )
              : h('div', { className: 'dl-state' }, t('status.noData')),
            h(
              'div',
              { className: 'dl-evidence' },
              h('span', { className: health === null || health.evidence === 'no-run-report' ? 'dl-tone-idle' : '' }, evidenceText),
              health !== null && typeof health.lastRunAt === 'string' && health.lastRunAt !== ''
                ? h('span', null, t('health.lastRun', { at: health.lastRunAt }))
                : null
            ),
            reconcileLine
          );
        }

        // ---- ② 计数 ----
        function renderCountsCard() {
          if (summary.state === 'loading') {
            return h(
              'section',
              { className: 'dl-card' },
              cardHead(t('section.counts'), null, null),
              h('div', { className: 'dl-state dl-state-loading' }, t('status.loading'))
            );
          }
          if (summary.state === 'error') {
            return h(
              'section',
              { className: 'dl-card' },
              cardHead(t('section.counts'), null, null),
              errorLine(summary.reason, loadSummary)
            );
          }

          const counts = summaryData && summaryData.counts && typeof summaryData.counts === 'object'
            ? summaryData.counts
            : {};
          const handover = counts.handover && typeof counts.handover === 'object' ? counts.handover : {};
          const original = counts.original && typeof counts.original === 'object' ? counts.original : {};
          const weekly = counts.weekly && typeof counts.weekly === 'object' ? counts.weekly : {};

          const cards = [
            {
              key: 'handover',
              label: t('counts.handover'),
              value: numText(handover.total),
              sub: t('counts.handoverSub', { main: numText(handover.main), appendix: numText(handover.appendix) }),
            },
            {
              key: 'original',
              label: t('counts.original'),
              value: sumText(original.views, original.attachments),
              sub: t('counts.originalSub', { views: numText(original.views), attachments: numText(original.attachments) }),
            },
            {
              key: 'weekly',
              label: t('counts.weekly'),
              value: numText(weekly.files),
              sub: t('counts.weeklySub', { files: numText(weekly.files), sealed: numText(weekly.sealed) }),
            },
            {
              key: 'ledgerRows',
              label: t('counts.ledgerRows'),
              value: numText(counts.ledgerRows),
              sub: null,
            },
          ];

          return h(
            'section',
            { className: 'dl-card' },
            cardHead(t('section.counts'), null, null),
            h(
              'div',
              { className: 'dl-counts' },
              cards.map(function (card) {
                return h(
                  'div',
                  { className: 'dl-count', key: card.key },
                  h('div', { className: 'dl-count-label' }, card.label),
                  h('div', { className: 'dl-count-value' }, card.value),
                  card.sub !== null ? h('div', { className: 'dl-count-sub' }, card.sub) : null
                );
              })
            )
          );
        }

        // ---- ③ 检索 ----
        function renderDetail(detail) {
          if (detail.state === 'loading') {
            return h('div', { className: 'dl-state dl-state-loading' }, t('turn.loading'));
          }
          if (detail.state === 'error') {
            return h(
              'div',
              { className: 'dl-state dl-state-error', role: 'alert' },
              t('error.request', { message: detail.reason || t('status.unknown') })
            );
          }
          const data = detail.data || {};
          const row = data.row && typeof data.row === 'object' ? data.row : detail.row || {};
          const original = data.original && typeof data.original === 'object' ? data.original : {};
          const code = typeof row.code === 'string' && row.code !== '' ? row.code : detail.code;
          const path = typeof original.path === 'string' && original.path !== ''
            ? original.path
            : typeof row.doc === 'string'
              ? row.doc
              : '';
          const excerpt = typeof data.excerpt === 'string' ? data.excerpt : '';

          const parts = [
            h(
              'div',
              { className: 'dl-kv', key: 'code' },
              h('span', { className: 'dl-kv-label' }, t('detail.code')),
              h('code', { className: 'dl-mono' }, code),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dl-btn dl-btn-sm',
                  onClick: function (event) {
                    event.stopPropagation();
                    copy(t('action.copyCode'), code);
                  },
                },
                t('action.copyCode')
              )
            ),
            h(
              'div',
              { className: 'dl-kv', key: 'path' },
              h('span', { className: 'dl-kv-label' }, t('detail.path')),
              h('code', { className: 'dl-mono' }, path !== '' ? path : '—'),
              path !== ''
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'dl-btn dl-btn-sm',
                      onClick: function (event) {
                        event.stopPropagation();
                        copy(t('action.copyPath'), path);
                      },
                    },
                    t('action.copyPath')
                  )
                : null,
              original.exists === false
                ? h('span', { className: 'dl-chip dl-tone-warn' }, t('original.missing'))
                : null
            ),
          ];

          if (excerpt !== '') {
            parts.push(
              h(
                'pre',
                { className: 'dl-excerpt', key: 'excerpt' },
                excerpt,
                data.excerptTruncated === true ? '\n' + t('detail.excerptTruncated') : ''
              )
            );
          } else {
            parts.push(h('div', { className: 'dl-state', key: 'excerpt-empty' }, t('detail.excerptEmpty')));
          }

          const originalState = detail.originalState || 'idle';
          parts.push(
            h(
              'div',
              { className: 'dl-detail-actions', key: 'actions' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dl-btn dl-btn-sm',
                  disabled: originalState === 'loading',
                  onClick: function (event) {
                    event.stopPropagation();
                    viewOriginal(code);
                  },
                },
                originalState === 'loading' ? t('status.loading') : t('action.viewOriginal')
              ),
              originalState === 'ready' || originalState === 'error'
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'dl-btn dl-btn-sm',
                      onClick: function (event) {
                        event.stopPropagation();
                        hideOriginal(code);
                      },
                    },
                    t('action.hideOriginal')
                  )
                : null
            )
          );

          if (originalState === 'ready' && detail.original) {
            const originalText = typeof detail.original.text === 'string' ? detail.original.text : '';
            const bytes = typeof detail.original.bytes === 'number' ? String(detail.original.bytes) : '—';
            parts.push(
              h(
                'div',
                { className: 'dl-detail-original', key: 'original' },
                h('div', { className: 'dl-detail-meta' }, t('detail.originalTitle', { bytes: bytes })),
                // ★ V0.6.4：按行渲染（用户/Agent 对话加粗）；文本逐字不改，仅呈现层分组
                h(
                  'div',
                  { className: 'dl-original' },
                  renderOriginalLines(originalText, t('detail.originalTruncated'), detail.original.truncated === true)
                )
              )
            );
          } else if (originalState === 'error') {
            parts.push(
              h(
                'div',
                { className: 'dl-state dl-state-error', key: 'original-error', role: 'alert' },
                t('error.request', { message: detail.originalReason || t('status.unknown') })
              )
            );
          }

          return h('div', { className: 'dl-detail' }, parts);
        }

        function renderSearchCard() {
          const resultNote = (function () {
            if (search.state !== 'ready' && search.state !== 'empty') return null;
            const data = search.data || {};
            let note = t('search.total', { total: numText(data.total), scanned: numText(data.scanned) });
            if (data.truncated === true) note += ' · ' + t('search.truncated');
            if (typeof data.readErrors === 'number' && data.readErrors > 0) {
              note += ' · ' + t('search.readErrors', { n: String(data.readErrors) });
            }
            return note;
          })();

          const body = (function () {
            if (search.state === 'idle') {
              return h('div', { className: 'dl-state' }, t('search.idle'));
            }
            if (search.state === 'loading') {
              return h('div', { className: 'dl-state dl-state-loading' }, t('search.loading'));
            }
            if (search.state === 'error') {
              return errorLine(search.reason, function () {
                runSearch();
              });
            }
            if (search.state === 'empty') {
              return h('div', { className: 'dl-state' }, t('search.empty'));
            }
            const data = search.data || {};
            const rows = Array.isArray(data.rows) ? data.rows : [];
            return h(
              'div',
              { className: 'dl-table-wrap' },
              h(
                'table',
                { className: 'dl-table' },
                h(
                  'thead',
                  null,
                  h(
                    'tr',
                    null,
                    h('th', null, t('col.code')),
                    h('th', null, t('col.ts')),
                    h('th', null, t('col.turn')),
                    h('th', null, t('col.status')),
                    h('th', null, t('col.original'))
                  )
                ),
                h(
                  'tbody',
                  null,
                  rows.map(function (row, index) {
                    const code = typeof row.code === 'string' ? row.code : '';
                    const isOpen = expanded !== null && expanded.code === code;
                    const rowElement = h(
                      'tr',
                      {
                        className: 'dl-row',
                        'aria-expanded': isOpen ? 'true' : 'false',
                        tabIndex: 0,
                        onClick: function () {
                          toggleRow(row);
                        },
                        onKeyDown: function (event) {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            toggleRow(row);
                          }
                        },
                      },
                      h('td', { className: 'dl-cell-mono' }, code !== '' ? code : '—'),
                      h('td', { className: 'dl-cell-ts' }, row.ts ? h('span', { className: 'dl-mono' }, row.ts) : '—'),
                      h('td', null, row.turn === null || row.turn === undefined ? '—' : String(row.turn)),
                      h(
                        'td',
                        null,
                        h(
                          'span',
                          { className: 'dl-chip dl-tone-' + rowStatusTone(row.status) },
                          typeof row.status === 'string' && row.status !== '' ? row.status : '—'
                        )
                      ),
                      h(
                        'td',
                        null,
                        typeof row.doc === 'string' && row.doc !== ''
                          ? h('span', { className: 'dl-mono dl-cell-ellipsis', title: row.doc }, shortPath(row.doc))
                          : '—',
                        row.bound === false
                          ? h('span', { className: 'dl-chip dl-tone-warn dl-chip-gap' }, t('original.unbound'))
                          : null
                      )
                    );
                    if (!isOpen) {
                      return h(Fragment, { key: code + ':' + index }, rowElement);
                    }
                    return h(
                      Fragment,
                      { key: code + ':' + index },
                      rowElement,
                      h(
                        'tr',
                        { className: 'dl-detail-row' },
                        h('td', { className: 'dl-detail-cell', colSpan: 5 }, renderDetail(expanded))
                      )
                    );
                  })
                )
              )
            );
          })();

          return h(
            'section',
            { className: 'dl-card' },
            cardHead(t('section.search'), null, resultNote !== null ? h('span', { className: 'dl-card-note' }, resultNote) : null),
            h(
              'form',
              { className: 'dl-searchbar', onSubmit: runSearch },
              h(
                'label',
                { className: 'dl-field' },
                h('span', { className: 'dl-field-label' }, t('search.sid')),
                h('input', {
                  type: 'text',
                  className: 'dl-input',
                  value: sid,
                  placeholder: t('search.sidPlaceholder'),
                  spellCheck: false,
                  onChange: function (event) {
                    setSid(event.target.value);
                  },
                })
              ),
              h(
                'label',
                { className: 'dl-field' },
                h('span', { className: 'dl-field-label' }, t('search.month')),
                h('input', {
                  type: 'month',
                  className: 'dl-input dl-input-month',
                  value: month,
                  onChange: function (event) {
                    setMonth(event.target.value);
                  },
                })
              ),
              h('button', { type: 'submit', className: 'dl-btn dl-btn-primary' }, t('action.search'))
            ),
            body
          );
        }

        // ---- ④ 最近被查 ----
        function renderReadsCard() {
          const note = (function () {
            if (reads.state !== 'ready') return null;
            const data = reads.data || {};
            const summaryInfo = data.summary && typeof data.summary === 'object' ? data.summary : {};
            const lastAt = typeof summaryInfo.lastAt === 'string' && summaryInfo.lastAt !== ''
              ? summaryInfo.lastAt
              : Array.isArray(data.rows) && data.rows.length > 0 && typeof data.rows[0].at === 'string'
                ? data.rows[0].at
                : '';
            if (lastAt === '') return null;
            return t('reads.summary', { total: numText(data.total), at: lastAt });
          })();

          const body = (function () {
            if (reads.state === 'loading') {
              return h('div', { className: 'dl-state dl-state-loading' }, t('status.loading'));
            }
            if (reads.state === 'error') {
              return errorLine(reads.reason, loadReads);
            }
            const data = reads.data || {};
            const rows = Array.isArray(data.rows) ? data.rows : [];
            if (rows.length === 0) {
              return h('div', { className: 'dl-state' }, t('reads.empty'));
            }
            return h(
              'div',
              { className: 'dl-table-wrap' },
              h(
                'table',
                { className: 'dl-table' },
                h(
                  'thead',
                  null,
                  h(
                    'tr',
                    null,
                    h('th', null, t('reads.col.at')),
                    h('th', null, t('reads.col.tool')),
                    h('th', null, t('reads.col.hitCodes')),
                    h('th', null, t('reads.col.rows')),
                    h('th', null, t('reads.col.ms'))
                  )
                ),
                h(
                  'tbody',
                  null,
                  rows.slice(0, 20).map(function (row, index) {
                    const hitCodes = Array.isArray(row.hitCodes) ? row.hitCodes.length : 0;
                    return h(
                      'tr',
                      { key: (typeof row.at === 'string' ? row.at : '') + ':' + index },
                      h('td', { className: 'dl-cell-ts' }, h('span', { className: 'dl-mono' }, typeof row.at === 'string' && row.at !== '' ? row.at : '—')),
                      h(
                        'td',
                        null,
                        h('span', { className: 'dl-mono' }, typeof row.tool === 'string' && row.tool !== '' ? row.tool : '—'),
                        row.ok === false
                          ? h('span', { className: 'dl-chip dl-tone-bad dl-chip-gap' }, t('reads.failed'))
                          : null
                      ),
                      h('td', { className: 'dl-cell-num' }, String(hitCodes)),
                      h('td', { className: 'dl-cell-num' }, numText(row.returnedRows)),
                      h(
                        'td',
                        { className: 'dl-cell-ts' },
                        typeof row.ms === 'number' && isFinite(row.ms) ? t('reads.ms', { n: String(row.ms) }) : '—'
                      )
                    );
                  })
                )
              )
            );
          })();

          return h('section', { className: 'dl-card' }, cardHead(t('section.reads'), note, null), body);
        }

        return h(
          'div',
          { className: 'dl-panel' },
          renderTop(),
          ping.state === 'error' || (ping.state === 'ready' && ping.data && ping.data.ok === false)
            ? h(
                'div',
                { className: 'dl-banner dl-tone-bad', role: 'alert' },
                h('strong', null, t('error.pingFailed')),
                h('span', { className: 'dl-banner-hint' }, t('error.pingFailedHint'))
              )
            : null,
          renderHealthCard(),
          renderCountsCard(),
          renderSearchCard(),
          renderReadsCard(),
          flash !== null
            ? h('div', { className: 'dl-toast dl-tone-' + (flash.kind === 'ok' ? 'ok' : 'bad') }, flash.text)
            : null
        );
      }

      return LedgerPanel;
    }

    // ---------------------------------------------------------------------
    // 样式：只用 docs/验收-v0.6/接口契约.md 允许的 host 主题 token；
    // 由 apply 插入 <style data-plugin="dsh-dialog-ledger-v05">，卸载时移除。
    // ---------------------------------------------------------------------
    const CSS = `
.dl-panel {
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  overflow: auto;
  padding: 18px 22px 40px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-base);
  font-size: 13px;
  line-height: 1.6;
  font-family: inherit;
}
.dl-panel * { box-sizing: border-box; }
.dl-panel h1, .dl-panel h2, .dl-panel p { margin: 0; }
.dl-mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Cascadia Mono', 'Liberation Mono', monospace;
  font-size: 11.5px;
}
.dl-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
  flex-wrap: wrap;
  margin: 0 0 14px;
  padding: 12px 14px;
  background: var(--dsw-specific-sidebar-fill);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
}
.dl-top-main { min-width: 240px; flex: 1 1 320px; display: flex; flex-direction: column; gap: 5px; }
.dl-title-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.dl-title { font-size: 15px; font-weight: 600; letter-spacing: 0.02em; }
.dl-ping { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.dl-ping .dl-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; display: inline-block; }
.dl-tone-ok { color: var(--dsw-alias-state-success-primary); }
.dl-tone-bad { color: var(--dsw-alias-state-error-primary); }
.dl-tone-warn { color: var(--dsw-alias-state-warn-primary); }
.dl-tone-idle { color: var(--dsw-alias-state-idle-primary); }
.dl-sub { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 11.5px; color: var(--dsw-alias-label-secondary); min-width: 0; }
.dl-sub-label { color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.dl-sub-sep { color: var(--dsw-alias-border-l2); }
.dl-root {
  max-width: 560px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-secondary);
}
.dl-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.dl-btn {
  appearance: none;
  font: inherit;
  font-size: 12px;
  line-height: 1.4;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 7px;
  padding: 5px 10px;
  cursor: pointer;
  white-space: nowrap;
}
.dl-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-border-l2); }
.dl-btn:disabled { color: var(--dsw-alias-label-secondary); cursor: default; }
.dl-btn-primary { color: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }
.dl-btn-sm { padding: 3px 8px; font-size: 11.5px; }
.dl-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dl-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin: 0 0 14px;
  padding: 9px 12px;
  font-size: 12.5px;
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
}
.dl-banner strong { font-weight: 600; }
.dl-banner-hint { color: var(--dsw-alias-label-secondary); font-size: 11.5px; }
.dl-toast {
  position: fixed;
  right: 18px;
  bottom: 18px;
  z-index: 60;
  padding: 7px 12px;
  font-size: 12px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-overlay);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
}
.dl-card {
  margin: 0 0 14px;
  padding: 13px 15px;
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
}
.dl-card-health { border-top: 2px solid var(--dsw-alias-brand-primary); }
.dl-card-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
.dl-card-title { font-size: 13.5px; font-weight: 600; }
.dl-card-note { font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.dl-card-head-right { margin-left: auto; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dl-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 9px;
  font-size: 12px;
  font-weight: 600;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2);
}
.dl-badge.dl-tone-ok { border-color: var(--dsw-alias-state-success-primary); }
.dl-badge.dl-tone-bad { border-color: var(--dsw-alias-state-error-primary); }
.dl-badge.dl-tone-warn { border-color: var(--dsw-alias-state-warn-primary); }
.dl-badge.dl-tone-idle { border-color: var(--dsw-alias-state-idle-primary); }
.dl-metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(118px, 1fr)); gap: 8px; }
.dl-metric {
  min-width: 0;
  padding: 8px 10px;
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
}
.dl-metric-label { font-size: 11.5px; color: var(--dsw-alias-label-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dl-metric-value { margin-top: 2px; font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums; }
.dl-metric-value.dl-tone-ok { color: var(--dsw-alias-label-primary); }
.dl-metric-value.dl-tone-idle { color: var(--dsw-alias-label-secondary); }
.dl-metric-value.dl-tone-warn, .dl-metric-value.dl-tone-bad { font-weight: 700; }
.dl-evidence { display: flex; flex-wrap: wrap; gap: 4px 14px; margin-top: 10px; font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.dl-reconcile {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 12px;
  margin-top: 10px;
  padding-top: 9px;
  border-top: 1px dashed var(--dsw-alias-border-l1);
  font-size: 12px;
}
.dl-reconcile-title { font-weight: 600; }
.dl-counts { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
.dl-count {
  padding: 10px 12px;
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
}
.dl-count-label { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dl-count-value { margin-top: 2px; font-size: 20px; font-weight: 600; font-variant-numeric: tabular-nums; }
.dl-count-sub { margin-top: 2px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.dl-searchbar { display: flex; align-items: flex-end; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
.dl-field { display: flex; flex-direction: column; gap: 4px; }
.dl-field-label { font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.dl-input {
  font: inherit;
  font-size: 12.5px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 7px;
  padding: 5px 8px;
  min-width: 230px;
}
.dl-input-month { min-width: 160px; }
.dl-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.dl-table-wrap { overflow-x: auto; }
.dl-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.dl-table th, .dl-table td {
  border: 1px solid var(--dsw-alias-border-l1);
  padding: 5px 8px;
  text-align: left;
  vertical-align: top;
}
.dl-table th {
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  font-weight: 600;
  white-space: nowrap;
}
.dl-table tbody tr.dl-row { cursor: pointer; }
.dl-table tbody tr.dl-row:hover { background: var(--dsw-alias-bg-layer-2); }
.dl-table tbody tr.dl-row[aria-expanded='true'] { background: var(--dsw-alias-bg-layer-2); }
.dl-table tbody tr.dl-row:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
.dl-cell-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Cascadia Mono', 'Liberation Mono', monospace; font-size: 11.5px; word-break: break-all; }
.dl-cell-ts { white-space: nowrap; }
.dl-cell-num { font-variant-numeric: tabular-nums; }
.dl-cell-ellipsis { display: inline-block; max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom; }
.dl-detail-cell { background: var(--dsw-alias-bg-layer-2); }
.dl-detail { display: flex; flex-direction: column; gap: 8px; padding: 2px 0; }
.dl-kv { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; font-size: 12px; }
.dl-kv-label { color: var(--dsw-alias-label-secondary); font-size: 11.5px; white-space: nowrap; }
.dl-kv code { font-size: 11.5px; word-break: break-all; }
.dl-excerpt, .dl-original {
  margin: 0;
  padding: 8px 10px;
  max-height: 320px;
  overflow: auto;
  background: var(--dsw-alias-bg-base);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 7px;
  color: var(--dsw-alias-label-primary);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Cascadia Mono', 'Liberation Mono', monospace;
  font-size: 11.5px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
}
/* ★ V0.6.4：原文按行渲染后，用户/Agent 对话加粗，元数据/代码弱化（文本一字未改） */
.dl-original .dl-orig-line { white-space: pre-wrap; }
.dl-original .dl-orig-meta { color: var(--dsw-alias-label-secondary); }
.dl-original .dl-orig-head { font-weight: 700; }
.dl-original .dl-orig-dialog { font-weight: 700; }
.dl-original .dl-orig-code { color: var(--dsw-alias-label-secondary); }
.dl-detail-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.dl-detail-meta { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.dl-state { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 8px 2px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dl-state-error { color: var(--dsw-alias-state-error-primary); }
.dl-state-loading::before {
  content: '';
  display: inline-block;
  width: 10px;
  height: 10px;
  border: 2px solid var(--dsw-alias-border-l2);
  border-top-color: var(--dsw-alias-brand-primary);
  border-radius: 50%;
  animation: dl-spin 0.8s linear infinite;
}
@keyframes dl-spin { to { transform: rotate(360deg); } }
.dl-chip {
  display: inline-flex;
  align-items: center;
  padding: 0 6px;
  font-size: 11px;
  line-height: 18px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 999px;
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-layer-1);
  white-space: nowrap;
}
.dl-chip.dl-tone-ok { border-color: var(--dsw-alias-state-success-primary); }
.dl-chip.dl-tone-bad { border-color: var(--dsw-alias-state-error-primary); }
.dl-chip.dl-tone-warn { border-color: var(--dsw-alias-state-warn-primary); }
.dl-chip-gap { margin-left: 4px; }
@media (max-width: 720px) {
  .dl-panel { padding: 12px 12px 28px; }
  .dl-actions { justify-content: flex-start; }
  .dl-root { max-width: 100%; }
}
`;

    function apply(ctx) {
      // 文案字典
      ctx.effect(function () {
        return ctx.locale.register(NS, DICTS);
      }, PLUGIN_ID + ': dictionaries');

      const t = ctx.locale.bind(NS);

      // 样式：面板整页排版；卸载时移除 style 节点。
      ctx.effect(function () {
        if (typeof document === 'undefined' || document.head === null) return undefined;
        const selector = 'style[data-plugin="' + PLUGIN_ID + '"]';
        document.querySelectorAll(selector).forEach(function (node) {
          if (node.parentNode !== null) node.parentNode.removeChild(node);
        });
        const styleElement = document.createElement('style');
        styleElement.setAttribute('data-plugin', PLUGIN_ID);
        styleElement.textContent = CSS;
        document.head.appendChild(styleElement);
        return function () {
          if (styleElement.parentNode !== null) styleElement.parentNode.removeChild(styleElement);
        };
      }, PLUGIN_ID + ': styles');

      // 左栏图标（order=25：上下文洞察 20 与「更多」之间）
      ctx.slots.inject('sidebar.panellist', function () {
        return ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: 'dialog-ledger',
            order: 25,
            locale: NS,
            label: function () {
              return t('panel.title');
            },
          },
          LedgerIcon
        );
      });

      // 主面板：key 必须与图标 id 一致，点图标即选中
      const LedgerPanel = makeLedgerPanel(t);
      ctx.slots.inject('main', function () {
        return ctx.slots.register(
          {
            name: 'main',
            key: 'dialog-ledger',
            locale: NS,
          },
          LedgerPanel
        );
      });
    }

    return {
      name: PLUGIN_ID,
      inject: ['slots', 'locale'],
      apply: apply,
    };
  },
});
