window.__ModuleLoader__.load({
	id: "dsh-llm-agentrouter",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		//#region plugin
		/**
		 * Retired card host: 0.1.2–0.1.5 registered a hand-built endpoint card into
		 * `settings.plugin.item` via the `settingsScope` service; 0.1.7 removed both
		 * the service and the slot in favour of automatic pages — every activated
		 * entry's Config schema is reflected into the settings plane by the host,
		 * and the settings UI renders (and writes) it without any client half.
		 *
		 * The bundle keeps a client entry (the loader expects `./client`) so this
		 * module stays a no-op: nothing to inject, nothing to register.
		 */
		const inject = [];

		/**
		 * No-op apply: the endpoint choice now lives in the automatic settings page
		 * generated from the plugin's Config schema.
		 * @param {object} ctx - the browser plugin context (unused).
		 */
		function apply(ctx) {}
		//#endregion

		exports.SETTINGS_NS = "llm-agentrouter";
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
