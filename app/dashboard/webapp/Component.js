sap.ui.define([
    "sap/ui/core/UIComponent",
    "sap/ui/model/json/JSONModel"
], function(UIComponent, JSONModel) {
    "use strict";

    return UIComponent.extend("fileproc.dashboard.Component", {
        metadata: {
            manifest: "json"
        },

        init: function() {
            // Call parent init
            UIComponent.prototype.init.apply(this, arguments);

            // Initialize router
            this.getRouter().initialize();

            // Set app view model
            var oViewModel = new JSONModel({
                busy: false,
                autoRefresh: true,
                refreshInterval: 5000,  // 5 seconds
                lastRefresh: new Date()
            });
            this.setModel(oViewModel, "appView");
        },

        destroy: function() {
            UIComponent.prototype.destroy.apply(this, arguments);
        }
    });
});
