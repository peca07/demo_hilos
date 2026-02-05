sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/ui/model/Filter",
    "sap/ui/model/FilterOperator",
    "sap/ui/core/Fragment",
    "sap/m/MessageBox",
    "sap/m/MessageToast"
], function(Controller, JSONModel, Filter, FilterOperator, Fragment, MessageBox, MessageToast) {
    "use strict";

    return Controller.extend("fileproc.dashboard.controller.Main", {
        
        _refreshTimer: null,
        
        onInit: function() {
            // Initialize view model
            var oViewModel = new JSONModel({
                stats: {
                    totalJobs: 0,
                    processingJobs: 0,
                    readyJobs: 0,
                    doneJobs: 0,
                    errorJobs: 0
                },
                newJob: {
                    fileName: "",
                    filePath: ""
                }
            });
            this.getView().setModel(oViewModel, "viewModel");
            
            // Start auto-refresh
            this._startAutoRefresh();
            
            // Load initial stats
            this._loadStats();
        },
        
        onExit: function() {
            this._stopAutoRefresh();
        },
        
        // ==========================================
        // Auto Refresh
        // ==========================================
        
        _startAutoRefresh: function() {
            var that = this;
            var oAppViewModel = this.getOwnerComponent().getModel("appView");
            
            this._refreshTimer = setInterval(function() {
                if (oAppViewModel.getProperty("/autoRefresh")) {
                    that._doRefresh();
                }
            }, oAppViewModel.getProperty("/refreshInterval"));
        },
        
        _stopAutoRefresh: function() {
            if (this._refreshTimer) {
                clearInterval(this._refreshTimer);
                this._refreshTimer = null;
            }
        },
        
        onAutoRefreshChange: function(oEvent) {
            var bState = oEvent.getParameter("state");
            if (bState) {
                MessageToast.show(this._getText("autoRefreshEnabled"));
            } else {
                MessageToast.show(this._getText("autoRefreshDisabled"));
            }
        },
        
        onRefresh: function() {
            this._doRefresh();
            MessageToast.show(this._getText("refreshed"));
        },
        
        _doRefresh: function() {
            // Refresh the table binding
            var oTable = this.byId("jobsTable");
            if (oTable) {
                oTable.getBinding("items").refresh();
            }
            
            // Update stats
            this._loadStats();
            
            // Update last refresh time
            var oAppViewModel = this.getOwnerComponent().getModel("appView");
            oAppViewModel.setProperty("/lastRefresh", new Date());
        },
        
        // ==========================================
        // Stats Loading
        // ==========================================
        
        _loadStats: function() {
            var that = this;
            var oModel = this.getView().getModel();
            var oViewModel = this.getView().getModel("viewModel");
            
            // Count jobs by status using OData
            var oListBinding = oModel.bindList("/UploadJobs", null, null, null, {
                $count: true
            });
            
            oListBinding.requestContexts(0, 1000).then(function(aContexts) {
                var stats = {
                    totalJobs: aContexts.length,
                    processingJobs: 0,
                    readyJobs: 0,
                    doneJobs: 0,
                    errorJobs: 0,
                    newJobs: 0
                };
                
                aContexts.forEach(function(oContext) {
                    var sStatus = oContext.getProperty("status");
                    switch(sStatus) {
                        case "PROCESSING":
                            stats.processingJobs++;
                            break;
                        case "READY":
                            stats.readyJobs++;
                            break;
                        case "DONE":
                            stats.doneJobs++;
                            break;
                        case "ERROR":
                            stats.errorJobs++;
                            break;
                        case "NEW":
                            stats.newJobs++;
                            break;
                    }
                });
                
                oViewModel.setProperty("/stats", stats);
            }).catch(function(oError) {
                console.error("Error loading stats:", oError);
            });
        },
        
        // ==========================================
        // Create Job Dialog
        // ==========================================
        
        onCreateJobPress: function() {
            var that = this;
            var oView = this.getView();
            
            // Reset form
            var oViewModel = oView.getModel("viewModel");
            oViewModel.setProperty("/newJob", {
                fileName: "",
                filePath: ""
            });
            
            // Load dialog fragment
            if (!this._pCreateJobDialog) {
                this._pCreateJobDialog = Fragment.load({
                    id: oView.getId(),
                    name: "fileproc.dashboard.fragment.CreateJobDialog",
                    controller: this
                }).then(function(oDialog) {
                    oView.addDependent(oDialog);
                    return oDialog;
                });
            }
            
            this._pCreateJobDialog.then(function(oDialog) {
                oDialog.open();
            });
        },
        
        onCreateJobDialogClose: function() {
            this.byId("createJobDialog").close();
        },
        
        onCreateJobSubmit: function() {
            var that = this;
            var oView = this.getView();
            var oModel = oView.getModel();
            var oViewModel = oView.getModel("viewModel");
            var oNewJob = oViewModel.getProperty("/newJob");
            
            // Validate
            if (!oNewJob.fileName || !oNewJob.filePath) {
                MessageBox.error(this._getText("fillAllFields"));
                return;
            }
            
            // Set busy
            var oAppViewModel = this.getOwnerComponent().getModel("appView");
            oAppViewModel.setProperty("/busy", true);
            
            // Call createJob action
            var oOperation = oModel.bindContext("/createJob(...)");
            oOperation.setParameter("fileName", oNewJob.fileName);
            oOperation.setParameter("filePath", oNewJob.filePath);
            
            oOperation.execute().then(function(oContext) {
                var oResult = oOperation.getBoundContext().getObject();
                
                if (oResult && oResult.ID) {
                    // Job created, now start processing
                    return that._startProcessing(oResult.ID);
                } else {
                    throw new Error("Job creation failed");
                }
            }).then(function() {
                oAppViewModel.setProperty("/busy", false);
                that.byId("createJobDialog").close();
                that._doRefresh();
                MessageToast.show(that._getText("jobCreatedSuccess"));
            }).catch(function(oError) {
                oAppViewModel.setProperty("/busy", false);
                console.error("Error creating job:", oError);
                MessageBox.error(that._getText("jobCreatedError") + ": " + (oError.message || oError));
            });
        },
        
        _startProcessing: function(sJobId) {
            var oModel = this.getView().getModel();
            var oOperation = oModel.bindContext("/startProcessing(...)");
            oOperation.setParameter("jobId", sJobId);
            return oOperation.execute();
        },
        
        // ==========================================
        // Search
        // ==========================================
        
        onSearch: function(oEvent) {
            var sQuery = oEvent.getParameter("newValue");
            var oTable = this.byId("jobsTable");
            var oBinding = oTable.getBinding("items");
            
            var aFilters = [];
            if (sQuery) {
                aFilters.push(new Filter({
                    filters: [
                        new Filter("fileName", FilterOperator.Contains, sQuery),
                        new Filter("status", FilterOperator.Contains, sQuery),
                        new Filter("claimedBy", FilterOperator.Contains, sQuery)
                    ],
                    and: false
                }));
            }
            
            oBinding.filter(aFilters);
        },
        
        // ==========================================
        // Job Selection
        // ==========================================
        
        onJobSelect: function(oEvent) {
            var oItem = oEvent.getParameter("listItem");
            var oContext = oItem.getBindingContext();
            var sJobId = oContext.getProperty("ID");
            var sStatus = oContext.getProperty("status");
            
            // Could navigate to detail view or show popover
            console.log("Selected job:", sJobId, sStatus);
        },
        
        onStatTilePress: function(oEvent) {
            // Could filter table by status
            MessageToast.show("Tile pressed");
        },
        
        // ==========================================
        // Formatters
        // ==========================================
        
        formatStatusState: function(sStatus) {
            switch(sStatus) {
                case "DONE": return "Success";
                case "ERROR": return "Error";
                case "PROCESSING": return "Warning";
                case "READY": return "Information";
                case "NEW": return "None";
                case "CANCELED": return "None";
                default: return "None";
            }
        },
        
        formatStatusIcon: function(sStatus) {
            switch(sStatus) {
                case "DONE": return "sap-icon://accept";
                case "ERROR": return "sap-icon://error";
                case "PROCESSING": return "sap-icon://process";
                case "READY": return "sap-icon://queue";
                case "NEW": return "sap-icon://document";
                case "CANCELED": return "sap-icon://cancel";
                default: return "sap-icon://document";
            }
        },
        
        formatProgress: function(iProcessed, iTotal) {
            if (!iTotal || iTotal === 0) return 0;
            return Math.round((iProcessed / iTotal) * 100);
        },
        
        formatProgressText: function(iProcessed, iTotal) {
            if (!iTotal || iTotal === 0) return "0%";
            var iPercent = Math.round((iProcessed / iTotal) * 100);
            return iPercent + "%";
        },
        
        formatProgressState: function(sStatus) {
            switch(sStatus) {
                case "DONE": return "Success";
                case "ERROR": return "Error";
                case "PROCESSING": return "Warning";
                default: return "None";
            }
        },
        
        formatBytes: function(iBytes) {
            if (!iBytes || iBytes === 0) return "0 B";
            var k = 1024;
            var sizes = ["B", "KB", "MB", "GB"];
            var i = Math.floor(Math.log(iBytes) / Math.log(k));
            return parseFloat((iBytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
        },
        
        formatNumber: function(iNum) {
            if (!iNum && iNum !== 0) return "-";
            return iNum.toLocaleString("es-ES");
        },
        
        formatThroughput: function(iLinesPerSec) {
            if (!iLinesPerSec) return "-";
            return iLinesPerSec.toLocaleString("es-ES");
        },
        
        formatAvgBatch: function(sAvgBatchText) {
            if (!sAvgBatchText) return "";
            return "Avg batch: " + sAvgBatchText;
        },
        
        formatAttempts: function(iAttempts) {
            if (!iAttempts) return "";
            return "Intento " + iAttempts;
        },
        
        // ==========================================
        // Helpers
        // ==========================================
        
        _getText: function(sKey, aArgs) {
            var oResourceBundle = this.getOwnerComponent().getModel("i18n").getResourceBundle();
            return oResourceBundle.getText(sKey, aArgs);
        }
    });
});
