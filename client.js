/**
 * dsh-maend — browser half (DSH Web UI panel).
 *
 * Loaded by the DSH client module loader inside the web page. Registers:
 *   - main panel  : key "maend" (the dashboard body)
 *   - sidebar row : id  "maend" (glyph that opens the panel via layout.selectPanel)
 *
 * No MXU access happens here. Everything comes from the host half's
 * same-origin HTTP routes:
 *   GET  /api/dsh-maend/status
 *   POST /api/dsh-maend/action          { op, ...args }
 *   GET  /api/dsh-maend/screenshot?instance=<id>&t=<cache buster>
 *
 * This file must stay dependency free: `require('react')` is the only allowed
 * require, no build step, no JSX, no imports.
 */
window.__ModuleLoader__.load({
  id: 'dsh-maend',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const useState = React.useState;
    const useEffect = React.useEffect;
    const useRef = React.useRef;
    const useCallback = React.useCallback;

    /** Dictionary namespace owned by this plugin. */
    const NS = 'dsh-maend';
    /** Shared id of the sidebar entry and the main panel it opens. */
    const PANEL_ID = 'maend';
    /** Host route prefix. */
    const API = '/api/dsh-maend';
    const POLL_MS = 3000;
    const SHOT_MS = 2000;
    const STATUS_TIMEOUT_MS = 12000;

    /* ------------------------------------------------------------------ */
    /* dictionaries — built-in locales `zh` / `en`, identical key sets     */
    /* ------------------------------------------------------------------ */

    const zh = {
      panel: 'MaaEnd',
      unreachable: 'MaaEnd 不可达',
      connected: '已连接',
      disconnected: '未连接',
      running: '运行中',
      idle: '空闲',
      elevated: '管理员',
      noElevation: '非管理员',
      instance: '实例',
      noInstance: '无实例',
      run: '跑日常',
      stop: '停止',
      working: '处理中…',
      hooks: '自动化选项',
      muteOnStart: '启动后静音',
      unmuteOnFinish: '结束后取消静音',
      killGameOnFinish: '结束后关闭游戏',
      webhook: 'Webhook 地址',
      webhookPlaceholder: 'http://127.0.0.1:1234/hook',
      tasks: '任务',
      selectAll: '全选',
      selectNone: '全不选',
      tasksEmpty: '该实例没有任务',
      screen: '实时画面',
      noScreen: '无画面',
      logs: '日志',
      logsEmpty: '暂无日志',
      schedule: '定时策略',
      scheduleEmpty: '暂无定时策略',
      everyDay: '每天',
      workdays: '工作日',
      disabled: '已停用',
      join: '、',
      error: '错误',
      retry: '重试',
      renderCrash: 'MaaEnd 面板渲染出错',
      lastRun: '上次运行',
      loading: '加载中…',
      wd0: '周日',
      wd1: '周一',
      wd2: '周二',
      wd3: '周三',
      wd4: '周四',
      wd5: '周五',
      wd6: '周六',
    };

    const en = {
      panel: 'MaaEnd',
      unreachable: 'MaaEnd unreachable',
      connected: 'Connected',
      disconnected: 'Disconnected',
      running: 'Running',
      idle: 'Idle',
      elevated: 'Admin',
      noElevation: 'Not elevated',
      instance: 'Instance',
      noInstance: 'No instance',
      run: 'Run daily',
      stop: 'Stop',
      working: 'Working…',
      hooks: 'Automation options',
      muteOnStart: 'Mute on start',
      unmuteOnFinish: 'Unmute when done',
      killGameOnFinish: 'Close game when done',
      webhook: 'Webhook URL',
      webhookPlaceholder: 'http://127.0.0.1:1234/hook',
      tasks: 'Tasks',
      selectAll: 'Select all',
      selectNone: 'Clear all',
      tasksEmpty: 'No tasks in this instance',
      screen: 'Live screen',
      noScreen: 'No signal',
      logs: 'Logs',
      logsEmpty: 'No logs yet',
      schedule: 'Schedules',
      scheduleEmpty: 'No schedules',
      everyDay: 'Every day',
      workdays: 'Weekdays',
      disabled: 'disabled',
      join: ', ',
      error: 'Error',
      retry: 'Retry',
      renderCrash: 'MaaEnd panel failed to render',
      lastRun: 'Last run',
      loading: 'Loading…',
      wd0: 'Sun',
      wd1: 'Mon',
      wd2: 'Tue',
      wd3: 'Wed',
      wd4: 'Thu',
      wd5: 'Fri',
      wd6: 'Sat',
    };

    /* ------------------------------------------------------------------ */
    /* helpers                                                             */
    /* ------------------------------------------------------------------ */

    /** Same-origin JSON request with an optional timeout. Throws on failure. */
    async function requestJson(path, init, timeoutMs) {
      const options = Object.assign({ credentials: 'same-origin', cache: 'no-store' }, init || {});
      let controller = null;
      let timer = null;
      if (typeof AbortController === 'function' && timeoutMs > 0) {
        controller = new AbortController();
        options.signal = controller.signal;
        timer = setTimeout(function () {
          try {
            controller.abort();
          } catch (ignored) {
            /* ignore */
          }
        }, timeoutMs);
      }
      try {
        const response = await fetch(path, options);
        let payload = null;
        try {
          payload = await response.json();
        } catch (ignored) {
          payload = null;
        }
        if (!response.ok) {
          const reason = payload && typeof payload.error === 'string' && payload.error ? payload.error : 'HTTP ' + response.status;
          throw new Error(reason);
        }
        if (payload === null) throw new Error('empty response');
        return payload;
      } catch (cause) {
        if (cause && cause.name === 'AbortError') throw new Error('请求超时');
        throw cause;
      } finally {
        if (timer !== null) clearTimeout(timer);
      }
    }

    function pad2(value) {
      return value < 10 ? '0' + value : String(value);
    }

    /** Local `HH:MM:SS` for an ISO timestamp (bad values fall back to text). */
    function formatTime(value) {
      if (value === null || value === undefined || value === '') return '';
      const date = value instanceof Date ? value : new Date(value);
      if (isNaN(date.getTime())) {
        const text = String(value);
        const match = text.match(/(\d{2}):(\d{2})(?::(\d{2}))?/);
        return match ? match[1] + ':' + match[2] + ':' + (match[3] || '00') : text;
      }
      return pad2(date.getHours()) + ':' + pad2(date.getMinutes()) + ':' + pad2(date.getSeconds());
    }

    /** Local `HH:MM` for an ISO timestamp. */
    function formatShortTime(value) {
      const full = formatTime(value);
      return full.length >= 5 ? full.slice(0, 5) : full;
    }

    /** `weekdays` are 0..6 with 0 = Sunday (same as Date.getDay()). */
    function weekdaysText(days, t) {
      const list = Array.isArray(days)
        ? days.filter(function (day) {
            return typeof day === 'number' && day >= 0 && day <= 6;
          })
        : [];
      if (list.length === 0) return '';
      if (list.length === 7) return t('everyDay');
      const sorted = list.slice().sort(function (left, right) {
        return left - right;
      });
      if (sorted.length === 5 && sorted[0] === 1 && sorted[4] === 5) return t('workdays');
      return sorted
        .map(function (day) {
          return t('wd' + day);
        })
        .join(t('join'));
    }

    /** ISO-ish timestamps on MXU logs sometimes arrive without a zone. */
    function logTime(value) {
      const text = formatTime(value);
      if (text && text.length >= 8) return text;
      const raw = String(value || '');
      const match = raw.match(/T?(\d{2}:\d{2}(?::\d{2})?)/);
      return match ? match[1] : raw;
    }

    /* ------------------------------------------------------------------ */
    /* styles — theme tokens only (with light-theme fallbacks)             */
    /* ------------------------------------------------------------------ */

    const rootStyle = {
      height: '100%',
      minHeight: '100%',
      boxSizing: 'border-box',
      overflowY: 'auto',
      padding:
        'calc(var(--dsh-frame-top-clearance, 0px) + 16px) clamp(14px, 2.4vw, 32px) 32px',
      background: 'var(--dsw-alias-bg-base, #ffffff)',
      color: 'var(--dsw-alias-label-primary, #1a1a1a)',
      display: 'flex',
      flexDirection: 'column',
      gap: '12px',
      fontFamily:
        'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
      fontSize: '13px',
      lineHeight: 1.5,
      minWidth: 0,
    };

    const cardStyle = {
      boxSizing: 'border-box',
      background: 'var(--dsw-alias-bg-layer-1, #ffffff)',
      border: '1px solid var(--dsw-alias-border-l2, #e4e4e4)',
      borderRadius: '10px',
      padding: '12px 14px',
      display: 'flex',
      flexDirection: 'column',
      gap: '10px',
      minWidth: 0,
    };

    const sectionHeadStyle = {
      display: 'flex',
      alignItems: 'baseline',
      justifyContent: 'space-between',
      gap: '8px',
      minWidth: 0,
    };

    const sectionTitleStyle = {
      fontSize: '13px',
      fontWeight: 600,
      color: 'var(--dsw-alias-label-primary, #1a1a1a)',
    };

    const sectionExtraStyle = {
      fontSize: '12px',
      color: 'var(--dsw-alias-label-tertiary, #8a8a8a)',
      whiteSpace: 'nowrap',
    };

    const sectionBodyStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: '8px',
      minWidth: 0,
    };

    const emptyStyle = {
      fontSize: '12px',
      color: 'var(--dsw-alias-label-tertiary, #9a9a9a)',
      padding: '2px 0',
    };

    const fieldStyle = {
      boxSizing: 'border-box',
      fontFamily: 'inherit',
      fontSize: '13px',
      color: 'var(--dsw-alias-label-primary, #1a1a1a)',
      background: 'var(--dsw-alias-bg-layer-2, #f5f5f5)',
      border: '1px solid var(--dsw-alias-border-l2, #d9d9d9)',
      borderRadius: '8px',
      padding: '5px 9px',
      outline: 'none',
      minWidth: 0,
    };

    function buttonStyle(kind, disabled) {
      const primary = kind === 'primary';
      return {
        boxSizing: 'border-box',
        fontFamily: 'inherit',
        fontSize: '13px',
        fontWeight: 500,
        lineHeight: '20px',
        padding: '5px 14px',
        borderRadius: '8px',
        border: primary
          ? '1px solid transparent'
          : '1px solid var(--dsw-alias-border-l2, #d9d9d9)',
        background: primary
          ? 'var(--dsw-alias-button-primary-fill, #3b6cf2)'
          : 'var(--dsw-alias-bg-layer-2, #f5f5f5)',
        color: primary
          ? 'var(--dsw-alias-label-primary-inverted, #ffffff)'
          : 'var(--dsw-alias-label-primary, #1a1a1a)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        whiteSpace: 'nowrap',
      };
    }

    function smallButtonStyle(disabled) {
      return {
        boxSizing: 'border-box',
        fontFamily: 'inherit',
        fontSize: '12px',
        lineHeight: '18px',
        padding: '1px 9px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-l2, #d9d9d9)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary, #5c5c5c)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        whiteSpace: 'nowrap',
      };
    }

    const monoFont =
      '"Cascadia Mono", "Consolas", "Courier New", Menlo, monospace';

    /* ------------------------------------------------------------------ */
    /* small presentational components                                     */
    /* ------------------------------------------------------------------ */

    /** Accessible switch (`role="switch"`), themed track + thumb. */
    function Switch(props) {
      const checked = Boolean(props.checked);
      const disabled = Boolean(props.disabled);
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': checked ? 'true' : 'false',
          'aria-label': props.label || undefined,
          disabled: disabled,
          onClick: function () {
            if (disabled) return;
            if (typeof props.onChange === 'function') props.onChange(!checked);
          },
          style: {
            position: 'relative',
            flex: '0 0 auto',
            width: '38px',
            height: '22px',
            padding: 0,
            borderRadius: '11px',
            border: checked
              ? '1px solid transparent'
              : '1px solid var(--dsw-alias-border-l3, #cfcfcf)',
            background: checked
              ? 'var(--dsw-alias-button-primary-fill, #3b6cf2)'
              : 'var(--dsw-alias-bg-layer-3, #eaeaea)',
            cursor: disabled ? 'not-allowed' : 'pointer',
            opacity: disabled ? 0.55 : 1,
            transition: 'background-color 120ms ease',
          },
        },
        h('span', {
          style: {
            position: 'absolute',
            top: '2px',
            left: checked ? '18px' : '2px',
            width: '16px',
            height: '16px',
            borderRadius: '50%',
            background: 'var(--dsw-alias-switch-thumb, #ffffff)',
            boxShadow: '0 1px 2px rgba(0, 0, 0, 0.28)',
            transition: 'left 120ms ease',
          },
        }),
      );
    }

    /** Label on the left, switch on the right. */
    function SwitchRow(props) {
      return h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '12px',
            minWidth: 0,
          },
        },
        h(
          'span',
          {
            style: {
              fontSize: '13px',
              color: 'var(--dsw-alias-label-primary, #1a1a1a)',
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            },
          },
          props.label,
        ),
        h(Switch, {
          checked: props.checked,
          disabled: props.disabled,
          label: props.label,
          onChange: props.onChange,
        }),
      );
    }

    /** Card with a section header. */
    function Section(props) {
      const extra =
        props.extra === undefined || props.extra === null || props.extra === ''
          ? null
          : h('span', { key: 'extra', style: sectionExtraStyle }, props.extra);
      return h(
        'section',
        { style: cardStyle },
        h('div', { style: sectionHeadStyle }, [
          h('span', { key: 'title', style: sectionTitleStyle }, props.title),
          extra,
        ]),
        h('div', { style: sectionBodyStyle }, props.children),
      );
    }

    /** Sidebar glyph: a rounded box with an "M" (= MaaEnd mark). */
    function SidebarGlyph(props) {
      const size = Number(props && props.size) > 0 ? Number(props.size) : 18;
      const active = Boolean(props && props.active);
      return h(
        'span',
        {
          title: 'MaaEnd',
          onClick: function () {
            if (props && typeof props.onSelect === 'function') props.onSelect();
          },
          style: {
            display: 'inline-flex',
            width: size + 'px',
            height: size + 'px',
            alignItems: 'center',
            justifyContent: 'center',
            color: active
              ? 'var(--dsw-alias-label-primary, #1a1a1a)'
              : 'var(--dsw-alias-label-secondary, #6b6b6b)',
          },
        },
        h(
          'svg',
          {
            width: size,
            height: size,
            viewBox: '0 0 24 24',
            fill: 'none',
            xmlns: 'http://www.w3.org/2000/svg',
            'aria-hidden': 'true',
            focusable: 'false',
          },
          h('rect', {
            x: 3.2,
            y: 3.2,
            width: 17.6,
            height: 17.6,
            rx: 4.4,
            stroke: 'currentColor',
            strokeWidth: 1.7,
          }),
          h('path', {
            d: 'M7.4 16.4V8.6l4.6 4.4 4.6-4.4v7.8',
            stroke: 'currentColor',
            strokeWidth: 1.7,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          }),
        ),
      );
    }

    /** Render guard: keeps one bad render from taking the whole panel down. */
    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }

      static getDerivedStateFromError(error) {
        return { error: error };
      }

      componentDidCatch(error) {
        try {
          console.error('[dsh-maend] panel render failed:', error);
        } catch (ignored) {
          /* ignore */
        }
      }

      render() {
        const t = this.props.t;
        const tr = function (key, fallback) {
          try {
            return t ? t(key) : fallback;
          } catch (ignored) {
            return fallback;
          }
        };
        if (this.state.error) {
          const detail = String(
            (this.state.error && this.state.error.message) || this.state.error,
          );
          return h(
            'div',
            {
              style: {
                padding:
                  'calc(var(--dsh-frame-top-clearance, 0px) + 24px) clamp(14px, 2.4vw, 32px)',
                color: 'var(--dsw-alias-label-error, #d33)',
                fontSize: '13px',
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
                alignItems: 'flex-start',
              },
            },
            h('div', { style: { fontWeight: 600 } }, tr('renderCrash', 'MaaEnd panel failed to render')),
            h(
              'div',
              {
                style: {
                  fontSize: '12px',
                  fontFamily: monoFont,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                },
              },
              detail,
            ),
            h(
              'button',
              {
                type: 'button',
                onClick: function () {
                  this.setState({ error: null });
                }.bind(this),
                style: buttonStyle('secondary', false),
              },
              tr('retry', 'Retry'),
            ),
          );
        }
        return this.props.children;
      }
    }

    /* ------------------------------------------------------------------ */
    /* the dashboard                                                       */
    /* ------------------------------------------------------------------ */

    function MaendPanel(props) {
      const t = props.t;

      const [data, setData] = useState(null);
      const [error, setError] = useState('');
      const [busy, setBusy] = useState('');
      const [shotTick, setShotTick] = useState(0);
      const [shotBroken, setShotBroken] = useState(false);
      const [urlDraft, setUrlDraft] = useState(null);
      const statusInFlight = useRef(false);

      /** Fetch the dashboard snapshot. Never throws. */
      const refresh = useCallback(async function () {
        if (statusInFlight.current) return;
        statusInFlight.current = true;
        try {
          const payload = await requestJson(API + '/status?logs=30', null, STATUS_TIMEOUT_MS);
          setData(payload && typeof payload === 'object' ? payload : null);
          if (payload && payload.ok === false && payload.error) setError(String(payload.error));
          else setError('');
        } catch (cause) {
          setError(String((cause && cause.message) || cause));
        } finally {
          statusInFlight.current = false;
        }
      }, []);

      /** POST one action; returns `{ ok, result?, error? }` and never throws. */
      const dispatch = useCallback(async function (body) {
        setBusy(String((body && body.op) || 'action'));
        try {
          const payload = await requestJson(
            API + '/action',
            {
              method: 'POST',
              headers: { 'content-type': 'application/json', accept: 'application/json' },
              body: JSON.stringify(body || {}),
            },
            0,
          );
          if (!payload || payload.ok !== true) {
            throw new Error((payload && payload.error) || '操作失败');
          }
          setError('');
          return { ok: true, result: payload.result };
        } catch (cause) {
          const message = String((cause && cause.message) || cause);
          setError(message);
          return { ok: false, error: message };
        } finally {
          setBusy('');
        }
      }, []);

      /** POST one action then reload the snapshot. Never throws. */
      const act = useCallback(
        async function (body) {
          const outcome = await dispatch(body);
          await refresh();
          return outcome;
        },
        [dispatch, refresh],
      );

      /* poll the snapshot while this panel is mounted and visible */
      useEffect(
        function () {
          let disposed = false;
          const tick = function () {
            if (disposed) return;
            if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
            refresh();
          };
          tick();
          const timer = setInterval(tick, POLL_MS);
          const onVisible = function () {
            if (typeof document === 'undefined') return;
            if (document.visibilityState === 'visible') refresh();
          };
          if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
          return function () {
            disposed = true;
            clearInterval(timer);
            if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
          };
        },
        [refresh],
      );

      const instances = data && Array.isArray(data.instances) ? data.instances : [];
      const selectedId = (data && data.selectedInstance) || '';
      const current =
        instances.filter(function (item) {
          return item.id === selectedId;
        })[0] || null;
      const reachable = Boolean(data && data.reachable === true);
      const connected = Boolean(current && current.connected);
      const running = Boolean(current && current.running);
      const hooks = (data && data.hooks) || {};
      const allTasks = current && Array.isArray(current.tasks) ? current.tasks : [];
      /* MXU 的特殊任务（静音 / 关游戏 / webhook …）也会出现在实例任务列表里：
         它们在任务列表中被显式写入了 config，因此这里同样展示、允许开关。 */
      const tasks = allTasks;
      const enabledCount = tasks.filter(function (task) {
        return Boolean(task.enabled);
      }).length;
      const schedules = current && Array.isArray(current.schedules) ? current.schedules : [];
      const logs = data && Array.isArray(data.logs) ? data.logs : [];
      const recentLogs = logs.slice(-30).reverse();
      const locked = Boolean(busy) || !reachable;
      const webhookValue = urlDraft === null ? String(hooks.webhookUrl || '') : urlDraft;

      /* refresh the live frame while the panel is open, visible and reachable */
      useEffect(
        function () {
          setShotBroken(false);
        },
        [selectedId],
      );

      useEffect(
        function () {
          if (!reachable || !selectedId) return undefined;
          const timer = setInterval(function () {
            if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
            setShotTick(function (value) {
              return (value + 1) % 1000000;
            });
          }, SHOT_MS);
          return function () {
            clearInterval(timer);
          };
        },
        [reachable, selectedId],
      );

      const onSelectInstance = function (event) {
        const nextId = event.target.value;
        if (!nextId || nextId === selectedId) return;
        act({ op: 'select', instanceId: nextId });
      };

      const onRun = function () {
        if (locked || !current || enabledCount === 0) return;
        act({
          op: 'run',
          instanceId: selectedId || undefined,
          inject: true,
          wait: false,
        });
      };

      const onStop = function () {
        if (locked) return;
        act({ op: 'stop', instanceId: selectedId || undefined });
      };

      const onToggleTask = function (task) {
        if (locked || !current) return;
        act({
          op: 'toggleTask',
          instanceId: current.id,
          taskId: task.id,
          enabled: !task.enabled,
        });
      };

      /* hooks live in the host (no MXU round-trip), so they stay editable
       * even when MaaEnd itself is not running — only in-flight work locks. */
      const onToggleHook = function (key) {
        if (busy) return;
        const body = { op: 'setHooks' };
        body[key] = !Boolean(hooks[key]);
        act(body);
      };

      const onSaveWebhook = function () {
        const next = String(webhookValue).trim();
        const previous = String(hooks.webhookUrl || '');
        if (next === previous) {
          setUrlDraft(null);
          return;
        }
        if (busy) return;
        act({ op: 'setHooks', webhookUrl: next }).then(function () {
          setUrlDraft(null);
        });
      };

      const onBulkTasks = function (enabled) {
        if (locked || !current) return;
        const targets = tasks.filter(function (task) {
          return Boolean(task.enabled) !== enabled;
        });
        if (targets.length === 0) return;
        const runSequential = async function () {
          for (let index = 0; index < targets.length; index += 1) {
            const outcome = await dispatch({
              op: 'toggleTask',
              instanceId: current.id,
              taskId: targets[index].id,
              enabled: enabled,
            });
            if (!outcome.ok) return;
          }
          await refresh();
        };
        runSequential();
      };

      /* ---------------- header ---------------- */

      const statusColor = !data
        ? 'var(--dsw-alias-label-tertiary, #9a9a9a)'
        : !reachable
          ? 'var(--dsw-alias-state-error-primary, #d33)'
          : connected
            ? 'var(--dsw-alias-state-success-primary, #2e7d32)'
            : 'var(--dsw-alias-state-warn-primary, #c77700)';

      const statusText = !data
        ? t('loading')
        : !reachable
          ? t('unreachable')
          : connected
            ? t('connected')
            : t('disconnected');

      const headerCard = h('header', { key: 'header', style: cardStyle }, [
        h(
          'div',
          {
            key: 'top',
            style: {
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: '8px 14px',
              minWidth: 0,
            },
          },
          [
            h(
              'div',
              {
                key: 'title',
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  marginRight: 'auto',
                  minWidth: 0,
                },
              },
              [
                h('span', { key: 'name', style: { fontSize: '17px', fontWeight: 600 } }, t('panel')),
                h(
                  'span',
                  {
                    key: 'state',
                    style: {
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '6px',
                      fontSize: '12px',
                      color: 'var(--dsw-alias-label-secondary, #6b6b6b)',
                    },
                  },
                  [
                    h('span', {
                      key: 'dot',
                      style: {
                        width: '8px',
                        height: '8px',
                        borderRadius: '50%',
                        background: statusColor,
                        flex: '0 0 auto',
                      },
                    }),
                    h('span', { key: 'text', style: { color: statusColor } }, statusText),
                    h(
                      'span',
                      {
                        key: 'runstate',
                        style: {
                          color: running
                            ? 'var(--dsw-alias-state-success-primary, #2e7d32)'
                            : 'var(--dsw-alias-label-tertiary, #8a8a8a)',
                        },
                      },
                      '· ' + (running ? t('running') : t('idle')),
                    ),
                  ],
                ),
              ],
            ),
            h('div', { key: 'actions', style: { display: 'flex', alignItems: 'center', gap: '8px' } }, [
              h(
                'button',
                {
                  key: 'run',
                  type: 'button',
                  onClick: onRun,
                  disabled: locked || !current || enabledCount === 0,
                  style: buttonStyle('primary', locked || !current || enabledCount === 0),
                },
                t('run'),
              ),
              h(
                'button',
                {
                  key: 'stop',
                  type: 'button',
                  onClick: onStop,
                  disabled: locked,
                  style: buttonStyle('secondary', locked),
                },
                t('stop'),
              ),
              busy
                ? h(
                    'span',
                    { key: 'busy', style: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, #8a8a8a)' } },
                    t('working'),
                  )
                : null,
            ]),
          ],
        ),
        h(
          'div',
          {
            key: 'controls',
            style: {
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: '10px 14px',
              minWidth: 0,
            },
          },
          [
            h(
              'label',
              {
                key: 'instance',
                style: {
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '8px',
                  fontSize: '12px',
                  color: 'var(--dsw-alias-label-secondary, #6b6b6b)',
                },
              },
              [
                h('span', { key: 'label' }, t('instance')),
                h(
                  'select',
                  {
                    key: 'select',
                    value: selectedId,
                    onChange: onSelectInstance,
                    disabled: Boolean(busy) || instances.length === 0,
                    style: Object.assign({}, fieldStyle, { maxWidth: '240px' }),
                  },
                  instances.length === 0
                    ? [h('option', { key: 'none', value: '' }, t('noInstance'))]
                    : instances.map(function (item) {
                        return h('option', { key: item.id, value: item.id }, item.name + ' · ' + item.id);
                      }),
                ),
              ],
            ),
            data && data.elevated === false
              ? h(
                  'span',
                  {
                    key: 'elev',
                    style: {
                      fontSize: '12px',
                      lineHeight: '18px',
                      color: 'var(--dsw-alias-state-warn-primary, #c77700)',
                      border: '1px solid var(--dsw-alias-border-l2, #d9d9d9)',
                      borderRadius: '999px',
                      padding: '0 8px',
                      whiteSpace: 'nowrap',
                    },
                  },
                  t('noElevation'),
                )
              : data && data.elevated === true
                ? h(
                    'span',
                    {
                      key: 'elev',
                      style: {
                        fontSize: '12px',
                        lineHeight: '18px',
                        color: 'var(--dsw-alias-label-tertiary, #8a8a8a)',
                        border: '1px solid var(--dsw-alias-border-l2, #d9d9d9)',
                        borderRadius: '999px',
                        padding: '0 8px',
                        whiteSpace: 'nowrap',
                      },
                    },
                    t('elevated'),
                  )
                : null,
            h(
              'div',
              {
                key: 'meta',
                style: {
                  marginLeft: 'auto',
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  gap: '12px',
                  fontSize: '12px',
                  color: 'var(--dsw-alias-label-tertiary, #8a8a8a)',
                  fontFamily: monoFont,
                  minWidth: 0,
                },
              },
              [
                data && data.baseUrl ? h('span', { key: 'base' }, data.baseUrl) : null,
                data && data.lastRun && data.lastRun.startedAt
                  ? h(
                      'span',
                      { key: 'last' },
                      t('lastRun') + ' ' + formatShortTime(data.lastRun.startedAt),
                    )
                  : null,
              ],
            ),
          ],
        ),
      ]);

      /* ---------------- body sections ---------------- */

      const errorLine = error
        ? h(
            'div',
            {
              key: 'error',
              role: 'alert',
              style: {
                color: 'var(--dsw-alias-label-error, #d33)',
                fontSize: '12px',
                lineHeight: 1.5,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              },
            },
            t('error') + ': ' + error,
          )
        : null;

      const hooksSection = h(Section, { key: 'hooks', title: t('hooks') }, [
        h(SwitchRow, {
          key: 'mute',
          label: t('muteOnStart'),
          checked: Boolean(hooks.muteOnStart),
          disabled: Boolean(busy),
          onChange: function () {
            onToggleHook('muteOnStart');
          },
        }),
        h(SwitchRow, {
          key: 'unmute',
          label: t('unmuteOnFinish'),
          checked: Boolean(hooks.unmuteOnFinish),
          disabled: Boolean(busy),
          onChange: function () {
            onToggleHook('unmuteOnFinish');
          },
        }),
        h(SwitchRow, {
          key: 'kill',
          label: t('killGameOnFinish'),
          checked: Boolean(hooks.killGameOnFinish),
          disabled: Boolean(busy),
          onChange: function () {
            onToggleHook('killGameOnFinish');
          },
        }),
        h(
          'div',
          {
            key: 'webhook',
            style: { display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 },
          },
          [
            h(
              'span',
              {
                key: 'label',
                style: {
                  flex: '0 0 auto',
                  fontSize: '12px',
                  color: 'var(--dsw-alias-label-secondary, #6b6b6b)',
                },
              },
              t('webhook'),
            ),
            h('input', {
              key: 'input',
              type: 'url',
              value: webhookValue,
              placeholder: t('webhookPlaceholder'),
              disabled: Boolean(busy),
              onChange: function (event) {
                setUrlDraft(event.target.value);
              },
              onBlur: onSaveWebhook,
              onKeyDown: function (event) {
                if (event.key !== 'Enter') return;
                try {
                  event.currentTarget.blur();
                } catch (ignored) {
                  /* ignore */
                }
              },
              style: Object.assign({}, fieldStyle, { flex: '1 1 220px', fontFamily: monoFont, fontSize: '12px' }),
            }),
          ],
        ),
      ]);

      const tasksSection = h(
        Section,
        {
          key: 'tasks',
          title: t('tasks'),
          extra: tasks.length > 0 ? enabledCount + ' / ' + tasks.length : undefined,
        },
        [
          h(
            'div',
            { key: 'bulk', style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
            [
              h(
                'button',
                {
                  key: 'all',
                  type: 'button',
                  onClick: function () {
                    onBulkTasks(true);
                  },
                  disabled: locked || tasks.length === 0,
                  style: smallButtonStyle(locked || tasks.length === 0),
                },
                t('selectAll'),
              ),
              h(
                'button',
                {
                  key: 'none',
                  type: 'button',
                  onClick: function () {
                    onBulkTasks(false);
                  },
                  disabled: locked || tasks.length === 0,
                  style: smallButtonStyle(locked || tasks.length === 0),
                },
                t('selectNone'),
              ),
            ],
          ),
          tasks.length === 0
            ? h('div', { key: 'empty', style: emptyStyle }, t('tasksEmpty'))
            : tasks.map(function (task, index) {
                return h(
                  'div',
                  {
                    key: task.id || 'task-' + index,
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: '12px',
                      padding: '5px 0',
                      borderBottom:
                        index < tasks.length - 1
                          ? '1px solid var(--dsw-alias-border-l1, #f0f0f0)'
                          : 'none',
                      minWidth: 0,
                    },
                  },
                  [
                    h(
                      'span',
                      {
                        key: 'name',
                        title: task.label || task.taskName || task.id,
                        style: {
                          minWidth: 0,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          fontSize: '13px',
                        },
                      },
                      task.label || task.taskName || task.id,
                    ),
                    h(Switch, {
                      key: 'switch',
                      checked: Boolean(task.enabled),
                      disabled: Boolean(busy),
                      label: task.label || task.taskName || task.id,
                      onChange: function () {
                        onToggleTask(task);
                      },
                    }),
                  ],
                );
              }),
        ],
      );

      const shotSrc =
        API + '/screenshot?instance=' + encodeURIComponent(selectedId) + '&t=' + shotTick;

      const screenSection =
        reachable && selectedId
          ? h(Section, { key: 'screen', title: t('screen') }, [
              h(
                'div',
                {
                  key: 'frame',
                  style: {
                    position: 'relative',
                    width: '100%',
                    aspectRatio: '16 / 9',
                    background: 'var(--dsw-alias-bg-layer-2, #f2f2f2)',
                    border: '1px solid var(--dsw-alias-border-l1, #ececec)',
                    borderRadius: '8px',
                    overflow: 'hidden',
                  },
                },
                [
                  h('img', {
                    key: 'img',
                    src: shotSrc,
                    alt: t('screen'),
                    draggable: false,
                    onLoad: function () {
                      setShotBroken(false);
                    },
                    onError: function () {
                      setShotBroken(true);
                    },
                    style: {
                      position: 'absolute',
                      inset: 0,
                      width: '100%',
                      height: '100%',
                      objectFit: 'contain',
                      display: shotBroken ? 'none' : 'block',
                    },
                  }),
                  shotBroken
                    ? h(
                        'div',
                        {
                          key: 'placeholder',
                          style: {
                            position: 'absolute',
                            inset: 0,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: '13px',
                            color: 'var(--dsw-alias-label-tertiary, #9a9a9a)',
                          },
                        },
                        t('noScreen'),
                      )
                    : null,
                ],
              ),
            ])
          : null;

      const logsSection = reachable
        ? h(Section, { key: 'logs', title: t('logs'), extra: recentLogs.length ? String(recentLogs.length) : undefined }, [
            h(
              'div',
              {
                key: 'list',
                style: {
                  maxHeight: '240px',
                  overflowY: 'auto',
                  background: 'var(--dsw-alias-bg-layer-2, #f7f7f7)',
                  border: '1px solid var(--dsw-alias-border-l1, #ececec)',
                  borderRadius: '8px',
                  padding: '8px 10px',
                  fontFamily: monoFont,
                  fontSize: '11.5px',
                  lineHeight: 1.55,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                },
              },
              recentLogs.length === 0
                ? h('div', { key: 'empty', style: emptyStyle }, t('logsEmpty'))
                : recentLogs.map(function (entry, index) {
                    const type = String((entry && entry.type) || 'info').toLowerCase();
                    const color =
                      type === 'error' || type === 'err' || type === 'fail'
                        ? 'var(--dsw-alias-state-error-primary, #d33)'
                        : type === 'warn' || type === 'warning'
                          ? 'var(--dsw-alias-state-warn-primary, #c77700)'
                          : 'var(--dsw-alias-label-secondary, #6b6b6b)';
                    return h(
                      'div',
                      {
                        key: String((entry && entry.id) || index) + ':' + index,
                        style: { color: color },
                      },
                      [
                        h(
                          'span',
                          {
                            key: 'time',
                            style: {
                              color: 'var(--dsw-alias-label-tertiary, #9a9a9a)',
                              marginRight: '8px',
                            },
                          },
                          logTime(entry && entry.timestamp),
                        ),
                        h('span', { key: 'msg' }, String((entry && entry.message) || '')),
                      ],
                    );
                  }),
            ),
          ])
        : null;

      const scheduleSection = reachable
        ? h(
            Section,
            {
              key: 'schedule',
              title: t('schedule'),
              extra: schedules.length > 0 ? String(schedules.length) : undefined,
            },
            schedules.length === 0
              ? [h('div', { key: 'empty', style: emptyStyle }, t('scheduleEmpty'))]
              : schedules.map(function (schedule, index) {
                  const days = weekdaysText(schedule && schedule.weekdays, t);
                  const times = Array.isArray(schedule && schedule.times)
                    ? schedule.times.filter(function (item) {
                        return Boolean(item);
                      })
                    : [];
                  const parts = [schedule && schedule.name ? String(schedule.name) : '—', days, times.join(' / ')].filter(
                    function (part) {
                      return part !== '';
                    },
                  );
                  return h(
                    'div',
                    {
                      key: (schedule && schedule.id) || 'schedule-' + index,
                      style: {
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        fontSize: '12.5px',
                        opacity: schedule && schedule.enabled === false ? 0.55 : 1,
                        minWidth: 0,
                      },
                    },
                    [
                      h(
                        'span',
                        {
                          key: 'text',
                          style: {
                            minWidth: 0,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          },
                        },
                        parts.join(' · '),
                      ),
                      schedule && schedule.enabled === false
                        ? h(
                            'span',
                            {
                              key: 'off',
                              style: {
                                flex: '0 0 auto',
                                fontSize: '11px',
                                color: 'var(--dsw-alias-label-tertiary, #9a9a9a)',
                              },
                            },
                            t('disabled'),
                          )
                        : null,
                    ],
                  );
                }),
          )
        : null;

      const nodes = [headerCard];
      if (errorLine) nodes.push(errorLine);
      if (!data) {
        nodes.push(
          h(
            'div',
            {
              key: 'loading',
              style: {
                padding: '18px 0',
                fontSize: '13px',
                color: 'var(--dsw-alias-label-tertiary, #9a9a9a)',
              },
            },
            t('loading'),
          ),
        );
      } else {
        nodes.push(hooksSection);
        if (reachable) {
          nodes.push(tasksSection);
          if (screenSection) nodes.push(screenSection);
          if (logsSection) nodes.push(logsSection);
          if (scheduleSection) nodes.push(scheduleSection);
        }
      }

      return h('div', { style: rootStyle }, nodes);
    }

    /* ------------------------------------------------------------------ */
    /* plugin wiring                                                       */
    /* ------------------------------------------------------------------ */

    function apply(ctx) {
      ctx.effect(function () {
        return ctx.locale.register(NS, { zh: zh, en: en });
      }, 'dsh-maend: dictionaries');

      const t = ctx.locale.bind(NS);

      /** Open the dashboard (the sidebar row already does this on click). */
      const openPanel = function () {
        try {
          ctx.layout.selectPanel(PANEL_ID);
        } catch (cause) {
          try {
            console.error('[dsh-maend] selectPanel failed:', cause);
          } catch (ignored) {
            /* ignore */
          }
        }
      };

      const PanelEntry = function MaaEndPanelEntry(props) {
        const bound = (props && props.t) || t;
        return h(PanelBoundary, { t: bound }, h(MaendPanel, { t: bound }));
      };

      const SidebarEntry = function MaaEndSidebarEntry(props) {
        return h(SidebarGlyph, {
          size: props && props.size,
          active: props && props.active,
          onSelect: openPanel,
        });
      };

      ctx.slots.inject('main', function () {
        return ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, PanelEntry);
      });

      ctx.slots.inject('sidebar.panellist', function () {
        return ctx.slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: 40, label: 'MaaEnd' },
          SidebarEntry,
        );
      });
    }

    return { inject: ['slots', 'layout', 'locale'], apply: apply };
  },
});
