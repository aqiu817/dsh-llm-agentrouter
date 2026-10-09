window.__ModuleLoader__.load({
	id: "dsh-llm-agentrouter",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		//#region locales
		/** Simplified Chinese dictionary and key source of truth. */
		const zh = {
			title: "AgentRouter 中转站",
			description: "端点与重试策略。改动保存后立即生效，模型列表不受影响。",
			endpoint: "端点",
			endpointHint: "国内端点适用于中国大陆网络；国际端点请先确认网络可达。",
			cn: "国内端点",
			intl: "国际端点",
			silentRetry: "静默重试",
			silentRetryHint:
				"中转站把请求轮流分配到多个上游通道，个别通道会以「请求无效」为由拒绝本可重试的请求。" +
				"开启后这类失败会在插件内部重新发送，不显示给会话；关闭则原样报错。",
			attempts: "最大尝试次数",
			attemptsHint: "开启静默重试时，单次请求最多发送几次。",
			readOnly: "当前部署不允许写入设置。",
			unavailable: "该插件当前未加载，暂时无法配置。",
			saveFailed: "本部署没有接受这些值，已保留供你修改。",
			save: "保存",
			saving: "保存中…",
		};
		/** English dictionary checked against the Chinese key set. */
		const en = {
			title: "AgentRouter relay",
			description: "Endpoint and retry policy. A saved change applies to the next request; the model list is unaffected.",
			endpoint: "Endpoint",
			endpointHint: "The domestic endpoint suits mainland China networks; confirm reachability before choosing the international one.",
			cn: "Domestic",
			intl: "International",
			silentRetry: "Silent retry",
			silentRetryHint:
				"The relay load-balances a request across several upstream pools, and individual pools reject retryable requests as invalid. " +
				"With this on, the plugin re-sends those failures internally instead of showing them to the session; off reports them as they arrive.",
			attempts: "Maximum attempts",
			attemptsHint: "Total sends one request may make while silent retry is on.",
			readOnly: "This deployment stores settings read-only.",
			unavailable: "This plugin is not loaded, so it cannot be configured right now.",
			saveFailed: "The deployment did not accept these values; they were left for you to correct.",
			save: "Save",
			saving: "Saving…",
		};
		/** The form frame's copy, read from this page's dictionary. */
		function formLabels(t) {
			return {
				unavailable: t("unavailable"),
				readOnly: t("readOnly"),
				saveFailed: t("saveFailed"),
				save: t("save"),
				saving: t("saving"),
			};
		}
		//#endregion

		//#region styles
		/*
		 * Written by hand rather than emitted from a CSS module: the `clientBundle`
		 * tsdown preset that produces those hashed class names is not published, so
		 * this bundle owns a prefixed class set and injects it once. Colours are
		 * shell design tokens, so the page follows the active theme.
		 */
		const CSS = [
			".dshAr_row{display:flex;flex-direction:column;gap:6px;margin:0 0 18px}",
			".dshAr_label{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:600;line-height:20px}",
			".dshAr_hint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}",
			".dshAr_toggle{display:flex;align-items:center;gap:10px}",
			".dshAr_attempts{display:flex;align-items:center;gap:10px;margin-top:2px}",
			".dshAr_attempts input{width:72px;box-sizing:border-box;padding:5px 9px;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);border-radius:7px}",
			".dshAr_attempts input:disabled{opacity:.55}",
		].join("");
		const CSS_TAG_ID = "dsh-llm-agentrouter/EndpointPage.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_TAG_ID) + "]") === null) {
			const tag = document.createElement("style");
			tag.setAttribute("data-plugin-css", CSS_TAG_ID);
			tag.textContent = CSS;
			document.head.append(tag);
		}
		//#endregion

		//#region endpoint page
		/** The endpoint keys this page offers, in display order. */
		const ENDPOINTS = ["cn", "intl"];
		/** Field carrying the endpoint choice inside the settings section. */
		const FIELD_ENDPOINT = "endpoint";
		/** Field carrying the silent-retry switch inside the settings section. */
		const FIELD_RETRY = "silentRetry";
		/** Field carrying the retry attempt bound inside the settings section. */
		const FIELD_ATTEMPTS = "silentRetryAttempts";

		/**
		 * Read one field out of a section value, tolerating a section that has not
		 * been served yet (the first render happens before the Host's describe
		 * answer lands, so `value` is undefined then).
		 * @param value - the snapshot's resolved section.
		 * @param field - field name to read.
		 * @returns the stored value, or undefined.
		 */
		function fieldOf(value, field) {
			return typeof value === "object" && value !== null ? value[field] : undefined;
		}

		/**
		 * The AgentRouter settings page.
		 *
		 * It stages nothing and saves explicitly through the shared settings form:
		 * the namespace holds two small fields, and the shell's save is the one
		 * place a draft becomes a document mutation. The endpoint is a segmented
		 * control rather than a text field because the schema admits exactly two
		 * values, and free text could only ever produce a rejected write.
		 *
		 * @param {object} props - the slot's kit: `form` (state plus mutate), the
		 *   bound translator `t`, and the view the Plugins page asks for.
		 * @returns {object} the one-liner, or the settings form.
		 */
		function AgentRouterPage(props) {
			const { t, form } = props;
			// The Plugins page renders the same entry twice: `summary` for the card's
			// one-liner and the detail header, and `page` for the form itself. Only
			// the `page` occurrence is handed a `form`, so the summary must not reach
			// for one — reading `form.state` unconditionally crashed the entry.
			const state = form?.state;

			// Drafts are local: the Host is the only authority on what a save
			// accepted, so the staged values live here until `mutate` answers.
			const [draft, setDraft] = react.useState(null);
			const [saving, setSaving] = react.useState(false);
			const [failed, setFailed] = react.useState(false);

			// Hooks must run on every render of this component, so the summary
			// return sits below them rather than short-circuiting the call.
			if (props.view === "summary" || state === undefined) return t("description");

			const endpoint = draft?.endpoint ?? fieldOf(state.value, FIELD_ENDPOINT) ?? "cn";
			const silentRetry = draft?.silentRetry ?? fieldOf(state.value, FIELD_RETRY) === true;
			const attempts = draft?.attempts ?? String(fieldOf(state.value, FIELD_ATTEMPTS) ?? 3);

			const writable = state.writable !== false;
			const dirty = draft !== null;

			const stage = (patch) => {
				setFailed(false);
				setDraft((current) => ({
					endpoint,
					silentRetry,
					attempts,
					...current,
					...patch,
				}));
			};

			const save = async () => {
				if (!dirty || saving) return;
				const parsedAttempts = Number.parseInt(attempts, 10);
				const ops = [];
				if (endpoint !== fieldOf(state.value, FIELD_ENDPOINT)) {
					ops.push({ op: "set", path: [FIELD_ENDPOINT], value: endpoint });
				}
				if (silentRetry !== (fieldOf(state.value, FIELD_RETRY) === true)) {
					ops.push({ op: "set", path: [FIELD_RETRY], value: silentRetry });
				}
				if (Number.isInteger(parsedAttempts) && parsedAttempts !== fieldOf(state.value, FIELD_ATTEMPTS)) {
					ops.push({ op: "set", path: [FIELD_ATTEMPTS], value: parsedAttempts });
				}
				setSaving(true);
				try {
					const landed = ops.length === 0 || (await form.mutate(ops, state.revision));
					if (landed) setDraft(null);
					else setFailed(true);
				} catch {
					setFailed(true);
				} finally {
					setSaving(false);
				}
			};

			const endpointOptions = ENDPOINTS.map((key) => ({ value: key, label: t(key) }));

			return react.createElement(
				primitives.SettingsForm,
				{
					labels: formLabels(t),
					state: {
						available: state.status !== "unavailable",
						writable,
						dirty,
						invalid: !Number.isInteger(Number.parseInt(attempts, 10)),
						saving,
						failed,
					},
					onSave: save,
					onDiscard: () => {
						setDraft(null);
						setFailed(false);
					},
				},
				react.createElement(
					"div",
					{ className: "dshAr_row" },
					react.createElement("span", { className: "dshAr_label", id: "dshAr-endpoint-label" }, t("endpoint")),
					react.createElement(primitives.SegmentedControl, {
						id: "dshAr-endpoint",
						value: endpoint,
						options: endpointOptions,
						onChange: (next) => stage({ endpoint: next }),
						label: t("endpoint"),
						disabled: !writable,
					}),
					react.createElement("p", { className: "dshAr_hint" }, t("endpointHint")),
				),
				react.createElement(
					"div",
					{ className: "dshAr_row" },
					react.createElement(
						"div",
						{ className: "dshAr_toggle" },
						react.createElement(primitives.Switch, {
							checked: silentRetry,
							onChange: (next) => stage({ silentRetry: next }),
							label: t("silentRetry"),
							disabled: !writable,
						}),
						react.createElement("span", { className: "dshAr_label" }, t("silentRetry")),
					),
					react.createElement("p", { className: "dshAr_hint" }, t("silentRetryHint")),
					react.createElement(
						"div",
						{ className: "dshAr_attempts" },
						react.createElement("span", { className: "dshAr_hint" }, t("attempts")),
						react.createElement("input", {
							type: "number",
							min: 1,
							max: 10,
							value: attempts,
							disabled: !writable || !silentRetry,
							"aria-label": t("attempts"),
							onChange: (event) => stage({ attempts: event.target.value }),
						}),
					),
					react.createElement("p", { className: "dshAr_hint" }, t("attemptsHint")),
				),
			);
		}
		//#endregion

		//#region plugin
		/** Dictionary namespace owned by this plugin. */
		const NS = "settings.agentrouter";
		/**
		 * Settings namespace the Host half registers. Spelled rather than imported:
		 * a browser bundle must not depend on a Host package, so both halves state
		 * the same literal (the Host's is `AGENTROUTER_SETTINGS_NAMESPACE`).
		 */
		const SETTINGS_NS = "llm-agentrouter";
		/** Services this plugin needs from the browser runtime. */
		const inject = ["slots", "locale", "configForms"];

		/**
		 * Register the endpoint page into the Plugins page.
		 *
		 * The page rides `configForms.whileServed`, so it appears only while the
		 * Host actually serves this namespace: a deployment that never mounted the
		 * Host half shows no trace of the page. The Host half previously relied on
		 * the settings plane reflecting its Config automatically, but no shipped
		 * client builds pages from the schema (`settings.describe` reports
		 * `autoGenerate` for clients that would, and none does), so the page has to
		 * be registered explicitly like every official companion package does.
		 *
		 * @param {object} ctx - the browser plugin context.
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "llm-agentrouter: dictionaries");
			const t = ctx.locale.bind(NS);
			ctx.effect(
				() =>
					ctx.configForms.whileServed([SETTINGS_NS], () =>
						ctx.slots.inject("plugins.item", () =>
							ctx.slots.register(
								{
									name: "plugins.item",
									id: SETTINGS_NS,
									order: 30,
									label: () => t("title"),
									locale: NS,
								},
								AgentRouterPage,
							),
						),
					),
				"llm-agentrouter: settings page",
			);
		}
		//#endregion

		exports.SETTINGS_NS = SETTINGS_NS;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
