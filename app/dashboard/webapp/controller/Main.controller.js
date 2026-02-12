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
                },
                // SharePoint
                sharePointFiles: [],
                sharePointExpanded: true,
                sharePointLoading: false,
                selectedSharePointFile: null
            });
            this.getView().setModel(oViewModel, "viewModel");
            
            // Wait for the OData model to be ready before loading data
            var that = this;
            this._waitForModel().then(function() {
                that._startAutoRefresh();
                that._loadStats();
                // Load SharePoint files on init
                that._loadSharePointFiles();
            }).catch(function(oError) {
                console.error("Error initializing model:", oError);
            });
        },
        
        _waitForModel: function() {
            var that = this;
            return new Promise(function(resolve, reject) {
                var oModel = that.getOwnerComponent().getModel();
                
                if (oModel) {
                    // Model exists, wait for metadata to load
                    oModel.getMetaModel().requestObject("/").then(function() {
                        resolve();
                    }).catch(function(oError) {
                        // Metadata failed but model exists, try anyway
                        console.warn("Metadata request failed, trying anyway:", oError);
                        resolve();
                    });
                } else {
                    // Model not ready yet, poll for it
                    var iAttempts = 0;
                    var iMaxAttempts = 20;
                    var fnCheckModel = function() {
                        iAttempts++;
                        var oModel = that.getOwnerComponent().getModel();
                        if (oModel) {
                            oModel.getMetaModel().requestObject("/").then(function() {
                                resolve();
                            }).catch(function() {
                                resolve();
                            });
                        } else if (iAttempts < iMaxAttempts) {
                            setTimeout(fnCheckModel, 250);
                        } else {
                            reject(new Error("Model not available after " + iMaxAttempts + " attempts"));
                        }
                    };
                    setTimeout(fnCheckModel, 250);
                }
            });
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
            
            if (!oAppViewModel) {
                console.warn("AppView model not available, skipping auto-refresh setup");
                return;
            }
            
            var iInterval = oAppViewModel.getProperty("/refreshInterval") || 5000;
            
            this._refreshTimer = setInterval(function() {
                if (oAppViewModel && oAppViewModel.getProperty("/autoRefresh")) {
                    that._doRefresh();
                }
            }, iInterval);
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
                var oBinding = oTable.getBinding("items");
                if (oBinding) {
                    oBinding.refresh();
                }
            }
            
            // Update stats
            this._loadStats();
            
            // Update last refresh time
            var oAppViewModel = this.getOwnerComponent().getModel("appView");
            if (oAppViewModel) {
                oAppViewModel.setProperty("/lastRefresh", new Date());
            }
        },
        
        // ==========================================
        // Stats Loading
        // ==========================================
        
        _loadStats: function() {
            var that = this;
            var oModel = this.getView().getModel();
            var oViewModel = this.getView().getModel("viewModel");
            
            // Check if model is available
            if (!oModel) {
                console.warn("OData model not available yet, skipping stats load");
                return;
            }
            
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
        // Clear Jobs
        // ==========================================
        
        onClearJobsPress: function() {
            var that = this;
            
            MessageBox.warning(this._getText("clearJobsConfirm"), {
                title: this._getText("clearJobsTitle"),
                actions: [
                    this._getText("deleteAllCompleted"),
                    this._getText("deleteAll"),
                    MessageBox.Action.CANCEL
                ],
                emphasizedAction: this._getText("deleteAllCompleted"),
                onClose: function(sAction) {
                    if (sAction === that._getText("deleteAllCompleted")) {
                        that._clearCompletedJobs();
                    } else if (sAction === that._getText("deleteAll")) {
                        // Confirmar eliminación total
                        MessageBox.confirm(that._getText("clearJobsWarning"), {
                            onClose: function(sConfirmAction) {
                                if (sConfirmAction === MessageBox.Action.OK) {
                                    that._clearAllJobs();
                                }
                            }
                        });
                    }
                }
            });
        },
        
        _clearCompletedJobs: function() {
            var that = this;
            var oModel = this.getView().getModel();
            var oAppViewModel = this.getOwnerComponent().getModel("appView");
            
            oAppViewModel.setProperty("/busy", true);
            
            var oOperation = oModel.bindContext("/clearCompletedJobs(...)");
            oOperation.execute().then(function() {
                var oResult = oOperation.getBoundContext().getObject();
                oAppViewModel.setProperty("/busy", false);
                that._doRefresh();
                MessageToast.show(that._getText("jobsCleared") + " (" + (oResult.deleted || 0) + ")");
            }).catch(function(oError) {
                oAppViewModel.setProperty("/busy", false);
                console.error("Error clearing jobs:", oError);
                MessageBox.error(that._getText("jobsClearedError"));
            });
        },
        
        _clearAllJobs: function() {
            var that = this;
            var oModel = this.getView().getModel();
            var oAppViewModel = this.getOwnerComponent().getModel("appView");
            
            oAppViewModel.setProperty("/busy", true);
            
            var oOperation = oModel.bindContext("/clearAllJobs(...)");
            oOperation.execute().then(function() {
                var oResult = oOperation.getBoundContext().getObject();
                oAppViewModel.setProperty("/busy", false);
                that._doRefresh();
                MessageToast.show(that._getText("jobsCleared") + " (" + (oResult.deleted || 0) + ")");
            }).catch(function(oError) {
                oAppViewModel.setProperty("/busy", false);
                console.error("Error clearing all jobs:", oError);
                MessageBox.error(that._getText("jobsClearedError"));
            });
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
            // Handle null, undefined, NaN, and zero values
            var processed = parseInt(iProcessed, 10) || 0;
            var total = parseInt(iTotal, 10) || 0;
            
            if (total === 0) return 0;
            
            var percent = Math.round((processed / total) * 100);
            return isNaN(percent) ? 0 : Math.min(percent, 100);
        },
        
        formatProgressText: function(iProcessed, iTotal) {
            // Handle null, undefined, NaN, and zero values
            var processed = parseInt(iProcessed, 10) || 0;
            var total = parseInt(iTotal, 10) || 0;
            
            if (total === 0) return "0%";
            
            var percent = Math.round((processed / total) * 100);
            if (isNaN(percent)) return "0%";
            return Math.min(percent, 100) + "%";
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
        
        formatFragments: function(iFragmentsDone, iNumFragments) {
            if (!iNumFragments || iNumFragments === 0) return "";
            var done = parseInt(iFragmentsDone, 10) || 0;
            var total = parseInt(iNumFragments, 10) || 0;
            return "Fragmentos: " + done + "/" + total;
        },
        
        formatErrors: function(iErrorLines) {
            if (!iErrorLines || iErrorLines === 0) return "";
            return "Errores: " + iErrorLines.toLocaleString("es-ES");
        },
        
        // ==========================================
        // SharePoint Integration
        // ==========================================
        
        onSharePointFilesPress: function() {
            // Toggle SharePoint panel expansion
            var oViewModel = this.getView().getModel("viewModel");
            var bExpanded = oViewModel.getProperty("/sharePointExpanded");
            oViewModel.setProperty("/sharePointExpanded", !bExpanded);
            
            // Load files if expanding and empty
            if (!bExpanded) {
                var aFiles = oViewModel.getProperty("/sharePointFiles");
                if (!aFiles || aFiles.length === 0) {
                    this._loadSharePointFiles();
                }
            }
        },
        
        onRefreshSharePoint: function() {
            this._loadSharePointFiles();
            MessageToast.show(this._getText("refreshed"));
        },
        
        _loadSharePointFiles: function() {
            var that = this;
            var oViewModel = this.getView().getModel("viewModel");
            var oSharePointModel = this.getOwnerComponent().getModel("sharepoint");
            
            if (!oSharePointModel) {
                console.warn("SharePoint model not available");
                return;
            }
            
            oViewModel.setProperty("/sharePointLoading", true);
            
            // Call listFiles function
            var oOperation = oSharePointModel.bindContext("/listFiles(...)");
            
            oOperation.execute().then(function() {
                var oResult = oOperation.getBoundContext().getObject();
                
                // Handle the result - it could be an array or have a value property
                var aFiles = [];
                if (Array.isArray(oResult)) {
                    aFiles = oResult;
                } else if (oResult && oResult.value) {
                    aFiles = oResult.value;
                } else if (oResult) {
                    // Single result or object with file properties
                    aFiles = [oResult];
                }
                
                console.log("[SharePoint] Loaded files:", aFiles.length);
                oViewModel.setProperty("/sharePointFiles", aFiles);
                oViewModel.setProperty("/sharePointLoading", false);
                
            }).catch(function(oError) {
                console.error("[SharePoint] Error loading files:", oError);
                oViewModel.setProperty("/sharePointLoading", false);
                oViewModel.setProperty("/sharePointFiles", []);
                MessageBox.error(that._getText("sharePointLoadError") + ": " + (oError.message || oError));
            });
        },
        
        onSharePointFileSelect: function(oEvent) {
            var oItem = oEvent.getParameter("listItem");
            var oContext = oItem.getBindingContext("viewModel");
            var oFile = oContext.getObject();
            
            var oViewModel = this.getView().getModel("viewModel");
            oViewModel.setProperty("/selectedSharePointFile", oFile);
            
            console.log("[SharePoint] Selected file:", oFile.name);
        },
        
        onProcessSharePointFile: function(oEvent) {
            var that = this;
            var oButton = oEvent.getSource();
            var oContext = oButton.getBindingContext("viewModel");
            var oFile = oContext.getObject();
            
            if (!oFile || !oFile.itemId) {
                MessageBox.error("No file selected");
                return;
            }
            
            // Confirm processing
            MessageBox.confirm(
                "¿Deseas crear un job de procesamiento para el archivo '" + oFile.name + "'?",
                {
                    title: "Procesar Archivo de SharePoint",
                    onClose: function(sAction) {
                        if (sAction === MessageBox.Action.OK) {
                            that._createJobFromSharePoint(oFile);
                        }
                    }
                }
            );
        },
        
        _createJobFromSharePoint: function(oFile) {
            var that = this;
            var oSharePointModel = this.getOwnerComponent().getModel("sharepoint");
            var oAppViewModel = this.getOwnerComponent().getModel("appView");
            
            oAppViewModel.setProperty("/busy", true);
            MessageToast.show(this._getText("sharePointFileProcessing"));
            
            // Call createJobFromSharePoint action
            var oOperation = oSharePointModel.bindContext("/createJobFromSharePoint(...)");
            oOperation.setParameter("itemId", oFile.itemId);
            oOperation.setParameter("fileName", oFile.name);
            
            oOperation.execute().then(function() {
                var sJobId = oOperation.getBoundContext().getObject();
                
                oAppViewModel.setProperty("/busy", false);
                MessageToast.show(that._getText("sharePointJobCreated"));
                
                // Refresh jobs table
                that._doRefresh();
                
                console.log("[SharePoint] Job created:", sJobId);
                
            }).catch(function(oError) {
                oAppViewModel.setProperty("/busy", false);
                console.error("[SharePoint] Error creating job:", oError);
                MessageBox.error(that._getText("sharePointJobError") + ": " + (oError.message || oError));
            });
        },
        
        onDownloadSharePointFile: function(oEvent) {
            var that = this;
            var oButton = oEvent.getSource();
            var oContext = oButton.getBindingContext("viewModel");
            var oFile = oContext.getObject();
            
            if (!oFile || !oFile.itemId) {
                MessageBox.error("No file selected");
                return;
            }
            
            var oSharePointModel = this.getOwnerComponent().getModel("sharepoint");
            
            // Get download URL
            var oOperation = oSharePointModel.bindContext("/getDownloadUrl(...)");
            oOperation.setParameter("itemId", oFile.itemId);
            
            oOperation.execute().then(function() {
                var oResult = oOperation.getBoundContext().getObject();
                
                if (oResult && oResult.url) {
                    // Open download URL in new tab
                    window.open(oResult.url, "_blank");
                } else {
                    throw new Error("No download URL returned");
                }
                
            }).catch(function(oError) {
                console.error("[SharePoint] Download error:", oError);
                MessageBox.error(that._getText("sharePointDownloadError") + ": " + (oError.message || oError));
            });
        },
        
        formatFileIcon: function(sMimeType) {
            if (!sMimeType) return "sap-icon://document";
            
            if (sMimeType.indexOf("text") !== -1) {
                return "sap-icon://document-text";
            } else if (sMimeType.indexOf("excel") !== -1 || sMimeType.indexOf("spreadsheet") !== -1) {
                return "sap-icon://excel-attachment";
            } else if (sMimeType.indexOf("word") !== -1) {
                return "sap-icon://doc-attachment";
            } else if (sMimeType.indexOf("pdf") !== -1) {
                return "sap-icon://pdf-attachment";
            } else if (sMimeType.indexOf("image") !== -1) {
                return "sap-icon://picture";
            } else if (sMimeType.indexOf("zip") !== -1 || sMimeType.indexOf("compressed") !== -1) {
                return "sap-icon://attachment-zip-file";
            }
            
            return "sap-icon://document";
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
