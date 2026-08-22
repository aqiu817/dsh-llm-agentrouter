window.__ModuleLoader__.load({
	id: "dsh-llm-agentrouter",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let jsx = require("react/jsx-runtime");
		let react = require("react");

		//#region styles
		/*
		 * Written by hand rather than emitted from a CSS module: the `clientBundle`
		 * tsdown preset that produces those hashed class names is not published, so
		 * this bundle owns a prefixed class set and injects it once. Every colour is
		 * a shell design token, so the card follows the active theme.
		 */
		const CSS = [
			".dshAr_card{display:flex;flex-direction:column;gap:10px}",
			".dshAr_lead{margin:0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}",
			".dshAr_choices{display:flex;gap:10px;margin:0;padding:0;border:0;flex-wrap:wrap}",
			".dshAr_choice{flex:1 1 200px;min-width:0;display:flex;gap:9px;align-items:flex-start;padding:11px 13px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-3);cursor:pointer}",
			".dshAr_choice:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".dshAr_choice[data-selected=true]{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 1px var(--dsw-alias-state-business-primary) inset}",
			".dshAr_choice[data-disabled=true]{cursor:default;opacity:.55}",
			".dshAr_choice input{margin:3px 0 0}",
			".dshAr_choiceText{display:flex;flex-direction:column;gap:2px;min-width:0}",
			".dshAr_choiceTitle{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:600;line-height:20px}",
			".dshAr_choiceHost{overflow-wrap:anywhere;color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code);font-size:12px;line-height:17px}",
			".dshAr_choiceHint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:17px}",
			".dshAr_status{margin:0;min-height:18px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}",
			".dshAr_status[data-kind=error]{color:var(--dsw-alias-state-error-primary)}",
		].join("");
		const CSS_TAG_ID = "dsh-llm-agentrouter/EndpointCard.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_TAG_ID) + "]") === null) {
			const tag = document.createElement("style");
			tag.setAttribute("data-plugin-css", CSS_TAG_ID);
			tag.textContent = CSS;
			document.head.append(tag);
		}
		//#endregion

		//#region locales
		/** Simplified Chinese dictionary and key source of truth. */
		const zh = {
			title: "AgentRouter 中转站",
			description: "选择请求发往的端点。切换后立即生效，无需重启；模型列表不受影响。",
			cn: "国内端点",
			cnHint: "如您区域处于中国大陆则更适用于该端点",
			intl: "国际端点",
			intlHint: "请确保您的网络环境支持访问该端点后切换",
			loading: "正在读取设置…",
			unavailable: "此浏览器无法读取该设置。",
			readOnly: "当前部署不允许写入设置。",
			saving: "正在保存…",
			saved: "已切换到%s。",
			failed: "保存失败，设置未更改。",
		};
		/** English dictionary checked against the Chinese key set. */
		const en = {
			title: "AgentRouter relay",
			description: "Which endpoint requests are sent to. A switch applies to the next request; the model list is unaffected.",
			cn: "Domestic endpoint",
			cnHint: "Better suited if you are in mainland China",
			intl: "International endpoint",
			intlHint: "Make sure your network can reach this endpoint before switching",
			loading: "Reading settings…",
			unavailable: "This browser cannot read these settings.",
			readOnly: "This deployment does not accept settings writes.",
			saving: "Saving…",
			saved: "Switched to %s.",
			failed: "The save failed; the setting is unchanged.",
		};
		//#endregion

		//#region endpoint card
		/** The endpoint keys this card offers, in display order. */
		const ENDPOINTS = ["cn", "intl"];
		/** Field this card writes inside its namespace. */
		const FIELD = "endpoint";

		/**
		 * Read the endpoint from a resolved section, falling back to the default the
		 * schema documents when the section is not readable yet.
		 * @param {unknown} value - the scope snapshot's resolved value.
		 * @returns {string} an endpoint key.
		 */
		function endpointOf(value) {
			const endpoint = typeof value === "object" && value !== null ? value.endpoint : undefined;
			return ENDPOINTS.includes(endpoint) ? endpoint : "cn";
		}

		/**
		 * Read the host table from a resolved section so each choice can show the
		 * origin it actually means.
		 * @param {unknown} value - the scope snapshot's resolved value.
		 * @returns {Record<string, string>} host per endpoint key.
		 */
		function hostsOf(value) {
			const hosts = typeof value === "object" && value !== null ? value.endpoints : undefined;
			return typeof hosts === "object" && hosts !== null ? hosts : {};
		}

		/**
		 * The relay endpoint card: one radio group over this plugin's own settings
		 * namespace.
		 *
		 * A choice writes immediately rather than staging behind a Save button. The
		 * namespace has exactly one user-facing field and the write is reversible in
		 * one click, so a staged form would add a step without protecting anything —
		 * and `scope.set` already fences the write with the revision it read.
		 *
		 * @param {object} props - the injected scope face plus the bound translator.
		 * @returns {JSX.Element} the card.
		 */
		function EndpointCard({ scope, t }) {
			const snapshot = react.useSyncExternalStore(
				react.useCallback((listener) => scope.subscribe(listener), [scope]),
				() => scope.getSnapshot(),
			);
			const [pending, setPending] = react.useState(null);
			const [failed, setFailed] = react.useState(false);
			const groupName = react.useId();

			const selected = endpointOf(snapshot.value);
			const hosts = hostsOf(snapshot.value);
			const disabled = snapshot.status !== "ready" || !snapshot.writable || pending !== null;

			const choose = (endpoint) => {
				if (endpoint === selected || disabled) return;
				setPending(endpoint);
				setFailed(false);
				Promise.resolve()
					.then(() => scope.set(FIELD, endpoint))
					.then(
						() => {
							setPending(null);
						},
						() => {
							setPending(null);
							setFailed(true);
						},
					);
			};

			const status = () => {
				if (snapshot.status === "loading") return { kind: "info", text: t("loading") };
				if (snapshot.status === "unavailable") return { kind: "error", text: t("unavailable") };
				if (failed) return { kind: "error", text: t("failed") };
				if (pending !== null) return { kind: "info", text: t("saving") };
				if (!snapshot.writable) return { kind: "info", text: t("readOnly") };
				return { kind: "info", text: "" };
			};
			const shown = status();

			return jsx.jsxs("section", {
				className: "dshAr_card",
				"data-plugin-card": "llm-agentrouter",
				"aria-busy": snapshot.status === "loading" || pending !== null,
				children: [
					jsx.jsx("h3", { children: t("title") }),
					jsx.jsx("p", { className: "dshAr_lead", children: t("description") }),
					jsx.jsxs("fieldset", {
						className: "dshAr_choices",
						children: [
							jsx.jsx("legend", { hidden: true, children: t("title") }),
							...ENDPOINTS.map((endpoint) => {
								const active = (pending ?? selected) === endpoint;
								return jsx.jsxs(
									"label",
									{
										className: "dshAr_choice",
										"data-endpoint": endpoint,
										"data-selected": active ? "true" : undefined,
										"data-disabled": disabled ? "true" : undefined,
										children: [
											jsx.jsx("input", {
												type: "radio",
												name: groupName,
												value: endpoint,
												checked: active,
												disabled: disabled && !active,
												onChange: () => choose(endpoint),
											}),
											jsx.jsxs("span", {
												className: "dshAr_choiceText",
												children: [
													jsx.jsx("span", { className: "dshAr_choiceTitle", children: t(endpoint) }),
													jsx.jsx("span", {
														className: "dshAr_choiceHost",
														children: hosts[endpoint] ?? "",
													}),
													jsx.jsx("span", { className: "dshAr_choiceHint", children: t(endpoint + "Hint") }),
												],
											}),
										],
									},
									endpoint,
								);
							}),
						],
					}),
					jsx.jsx("p", {
						className: "dshAr_status",
						"data-kind": shown.kind,
						role: shown.kind === "error" ? "alert" : "status",
						children: shown.text,
					}),
				],
			});
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
		const inject = ["slots", "locale", "settingsScope"];

		/**
		 * Register the endpoint card into the plugin configuration tab.
		 * @param {object} ctx - the browser plugin context.
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "llm-agentrouter: dictionaries");
			const t = ctx.locale.bind(NS);
			const scope = ctx.settingsScope.bind({ namespace: SETTINGS_NS });
			ctx.slots.inject("settings.plugin.item", () =>
				ctx.slots.register(
					{
						name: "settings.plugin.item",
						key: SETTINGS_NS,
						locale: NS,
						inject: () => ({ scope }),
					},
					EndpointCard,
				),
			);
		}
		//#endregion

		exports.NS = NS;
		exports.SETTINGS_NS = SETTINGS_NS;
		exports.EndpointCard = EndpointCard;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
