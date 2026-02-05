"use strict";

const cds = require("@sap/cds");
const proxy = require("@cap-js-community/odata-v2-adapter");
const express = require("express");
cds.on("bootstrap", app => {
    // Configurar límites de tamaño para poder subir archivos de 10mb usando LargeString en una entidad
    app.use(express.json({ limit: '10mb' }));
    app.use(express.urlencoded({ limit: '10mb', extended: true }));
    //--------------------------------------------

    app.use(proxy());

    // Servir archivo HTML en la raíz
    app.get("/", (_, res) => {
        res.sendFile(__dirname + "/index.html");
    });
    // Exponer endpoints dinámicamente
    app.get("/api/endpoints", async (_, res) => {
        const services = await cds.services;
        const endpoints = Object.values(services).map(srv => ({
            name: srv.name,
            url: `/odata/v4/${srv.name}`
        }));
        res.json(endpoints);
    });

    setInterval
});

module.exports = cds.server;