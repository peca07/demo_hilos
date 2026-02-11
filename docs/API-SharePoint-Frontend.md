# API SharePoint – Guía para desarrollador Frontend

Documentación para consumir las APIs de SharePoint y procesamiento de archivos desde un frontend (React, Angular, Vue, vanilla JS, etc.).

---

## Servicios disponibles

La aplicación expone **dos servicios OData V4**:

| Servicio | Base URL | Descripción |
|----------|----------|-------------|
| **SharePointService** | `/odata/v4/sharepoint` | Leer archivos de SharePoint y disparar jobs |
| **FileProcService** | `/odata/v4/file-proc` | Consultar estado de jobs, chunks y registros |

> En local: `http://localhost:4004/odata/v4/sharepoint`  
> En BTP: `https://<approuter-url>/odata/v4/sharepoint`

### Autenticación

- Requiere rol **`FileProcessor`**.
- Enviar siempre: `Accept: application/json`.
- Si aplica: `Authorization: Bearer <token>`.

---

## Flujo típico del frontend

```
1. Listar archivos de SharePoint     → GET  /sharepoint/listFiles()
2. Usuario selecciona un archivo
3. Disparar procesamiento             → POST /sharepoint/createJobFromSharePoint
4. Consultar estado del job           → GET  /file-proc/UploadJobs({jobId})
5. (Opcional) Descargar archivo       → GET  /sharepoint/getDownloadUrl(itemId='...')
```

---

## API 1 – Listar archivos de SharePoint

### `GET /odata/v4/sharepoint/listFiles()`

Devuelve los archivos del folder configurado por defecto en el backend.

#### Request

```http
GET /odata/v4/sharepoint/listFiles()
Accept: application/json
```

#### Ejemplo fetch

```javascript
const BASE = '/odata/v4/sharepoint';

async function listFiles() {
  const res = await fetch(`${BASE}/listFiles()`, {
    headers: { 'Accept': 'application/json' }
  });
  if (!res.ok) throw new Error(`Error ${res.status}`);
  const data = await res.json();
  return data.value; // Array de archivos
}
```

#### Ejemplo Axios

```javascript
const { data } = await axios.get('/odata/v4/sharepoint/listFiles()');
const files = data.value;
```

#### Respuesta

```json
{
  "value": [
    {
      "itemId": "01EYS6Y2JYBEFXDYCSRRHKGP5H4U2TBLN3",
      "name": "ventas_2024.csv",
      "size": 524288000,
      "mimeType": "text/csv",
      "webUrl": "https://tenant.sharepoint.com/sites/data/ventas_2024.csv",
      "createdAt": "2024-01-15T10:00:00Z",
      "modifiedAt": "2024-02-01T14:30:00Z"
    },
    {
      "itemId": "01EYS6Y2ABCDEFGHIJKLMNOP",
      "name": "reporte_enero.csv",
      "size": 1073741824,
      "mimeType": "text/csv",
      "webUrl": "https://tenant.sharepoint.com/sites/data/reporte_enero.csv",
      "createdAt": "2024-02-01T08:00:00Z",
      "modifiedAt": "2024-02-05T11:00:00Z"
    }
  ]
}
```

#### Campos de cada archivo

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `itemId` | string | ID único del archivo en SharePoint. **Usar para las demás llamadas.** |
| `name` | string | Nombre del archivo con extensión |
| `size` | number | Tamaño en bytes |
| `mimeType` | string | Tipo MIME (ej. `text/csv`) |
| `webUrl` | string | URL para abrir en SharePoint |
| `createdAt` | string (ISO) | Fecha de creación |
| `modifiedAt` | string (ISO) | Fecha de última modificación |

> **Nota sobre filtros:** Esta API no acepta filtros OData (`$filter`, `$orderby`, etc.) porque no es una entidad sino una `function`. El filtrado (por nombre, tamaño, fecha, etc.) debe hacerse **en el frontend** sobre el array `value` recibido.

---

## API 2 – Listar archivos de un folder específico

### `GET /odata/v4/sharepoint/listFilesInFolder(folderId='...')`

Igual que `listFiles()` pero para una carpeta distinta a la configurada por defecto.

#### Request

```http
GET /odata/v4/sharepoint/listFilesInFolder(folderId='01EYS6Y2XXXXXXXXXXXX')
Accept: application/json
```

#### Ejemplo fetch

```javascript
async function listFilesInFolder(folderId) {
  const res = await fetch(
    `${BASE}/listFilesInFolder(folderId='${encodeURIComponent(folderId)}')`,
    { headers: { 'Accept': 'application/json' } }
  );
  if (!res.ok) throw new Error(`Error ${res.status}`);
  const data = await res.json();
  return data.value;
}
```

#### Respuesta

Mismo formato que `listFiles()`.

---

## API 3 – Crear job desde SharePoint (disparar el workflow)

### `POST /odata/v4/sharepoint/createJobFromSharePoint`

Esta es la acción principal. Recibe un archivo de SharePoint, lo descarga en el backend, crea un job de procesamiento y lo arranca automáticamente.

- Si el archivo es **< 1 GB**: se procesa con un solo worker.
- Si el archivo es **>= 1 GB**: se divide en 5 chunks y se procesan en paralelo (5 workers).

#### Request

```http
POST /odata/v4/sharepoint/createJobFromSharePoint
Content-Type: application/json
Accept: application/json

{
  "itemId": "01EYS6Y2JYBEFXDYCSRRHKGP5H4U2TBLN3",
  "fileName": "ventas_2024.csv"
}
```

| Parámetro | Tipo | Requerido | Descripción |
|-----------|------|-----------|-------------|
| `itemId` | string | **Sí** | ID del archivo (campo `itemId` de `listFiles`) |
| `fileName` | string | **Sí** | Nombre del archivo (campo `name` de `listFiles`) |

#### Ejemplo fetch

```javascript
async function createJobFromSharePoint(file) {
  const res = await fetch(`${BASE}/createJobFromSharePoint`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({
      itemId: file.itemId,
      fileName: file.name
    })
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Error ${res.status}`);
  }

  const data = await res.json();
  return data.value; // UUID del job creado
}
```

#### Ejemplo Axios

```javascript
const { data } = await axios.post('/odata/v4/sharepoint/createJobFromSharePoint', {
  itemId: file.itemId,
  fileName: file.name
});
const jobId = data.value;
```

#### Ejemplo cURL

```bash
curl -X POST "https://tu-app/odata/v4/sharepoint/createJobFromSharePoint" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d '{"itemId":"01EYS6Y2JYBEFXDYCSRRHKGP5H4U2TBLN3","fileName":"ventas_2024.csv"}'
```

#### Respuesta (éxito)

```json
{
  "value": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
}
```

El valor es el **UUID del job creado**. Usarlo para consultar el estado.

#### Errores posibles

| HTTP Status | Significado |
|-------------|-------------|
| `400` | Faltan `itemId` o `fileName` en el body |
| `404` | Archivo no encontrado en SharePoint o sin URL de descarga |
| `507` | No hay espacio en disco en el servidor. Intentar más tarde |
| `500` | Error interno (ver mensaje en el campo `error.message`) |

---

## API 4 – Obtener URL de descarga directa

### `GET /odata/v4/sharepoint/getDownloadUrl(itemId='...')`

Devuelve una URL temporal (~1 hora de validez) para descargar el archivo directamente desde SharePoint en el navegador.

#### Request

```http
GET /odata/v4/sharepoint/getDownloadUrl(itemId='01EYS6Y2JYBEFXDYCSRRHKGP5H4U2TBLN3')
Accept: application/json
```

#### Ejemplo fetch

```javascript
async function downloadFile(itemId) {
  const res = await fetch(
    `${BASE}/getDownloadUrl(itemId='${encodeURIComponent(itemId)}')`,
    { headers: { 'Accept': 'application/json' } }
  );
  if (!res.ok) throw new Error(`Error ${res.status}`);
  const data = await res.json();

  // Abrir descarga en nueva pestaña
  window.open(data.url, '_blank');
}
```

#### Respuesta

```json
{
  "url": "https://tenant.sharepoint.com/_layouts/15/download.aspx?...",
  "expiresAt": "2024-02-09T15:00:00Z"
}
```

---

## API 5 – Consultar estado del job

### `GET /odata/v4/file-proc/UploadJobs({jobId})`

Una vez creado el job, puedes consultar su estado y progreso.

#### Request

```http
GET /odata/v4/file-proc/UploadJobs(a1b2c3d4-e5f6-7890-abcd-ef1234567890)
Accept: application/json
```

#### Ejemplo fetch

```javascript
async function getJobStatus(jobId) {
  const res = await fetch(`/odata/v4/file-proc/UploadJobs(${jobId})`, {
    headers: { 'Accept': 'application/json' }
  });
  if (!res.ok) throw new Error(`Error ${res.status}`);
  return await res.json();
}
```

#### Respuesta (ejemplo)

```json
{
  "ID": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "fileName": "ventas_2024.csv",
  "totalBytes": 524288000,
  "totalLines": 5000000,
  "status": "PROCESSING",
  "isChunked": false,
  "numChunks": 0,
  "chunksCompleted": 0,
  "processedBytes": 262144000,
  "processedLines": 2500000,
  "linesPerSecond": 45000,
  "totalDurationText": null,
  "errorMessage": null,
  "claimedBy": "worker-0-a3f2b1c4"
}
```

#### Estados posibles del job

| Status | Significado | Acción del frontend |
|--------|-------------|---------------------|
| `NEW` | Job creado, no encolado | Esperar |
| `COUNTING` | Contando líneas (archivo grande) | Mostrar spinner |
| `CHUNKED` | Dividido en chunks, workers procesando | Mostrar progreso por chunks |
| `READY` | En cola, esperando worker | Mostrar "En cola" |
| `PROCESSING` | Worker procesando | Mostrar barra de progreso |
| `DONE` | Completado | Mostrar resumen |
| `ERROR` | Error | Mostrar `errorMessage` |
| `PARTIAL_ERROR` | Algunos chunks fallaron | Mostrar detalle de chunks |
| `CANCELED` | Cancelado | - |

#### Campos útiles para la UI

| Campo | Para qué |
|-------|----------|
| `processedBytes` / `totalBytes` | Barra de progreso (porcentaje) |
| `processedLines` / `totalLines` | Líneas procesadas |
| `linesPerSecond` | Throughput en tiempo real |
| `totalDurationText` | "3min 25seg" (cuando termina) |
| `isChunked` | Si es true, mostrar info de chunks |
| `chunksCompleted` / `numChunks` | Progreso por chunks (ej. "3/5 chunks") |
| `errorMessage` | Mensaje de error si `status = ERROR` |

---

## API 6 – Listar todos los jobs

### `GET /odata/v4/file-proc/UploadJobs`

Lista todos los jobs. Acepta filtros OData estándar.

#### Filtros OData disponibles

```http
# Filtrar por estado
GET /odata/v4/file-proc/UploadJobs?$filter=status eq 'PROCESSING'

# Filtrar por nombre de archivo (contiene)
GET /odata/v4/file-proc/UploadJobs?$filter=contains(fileName,'ventas')

# Ordenar por fecha de creación (más recientes primero)
GET /odata/v4/file-proc/UploadJobs?$orderby=createdAt desc

# Paginación
GET /odata/v4/file-proc/UploadJobs?$top=10&$skip=0

# Contar total
GET /odata/v4/file-proc/UploadJobs?$count=true

# Combinado: últimos 10 jobs en procesamiento, ordenados
GET /odata/v4/file-proc/UploadJobs?$filter=status eq 'PROCESSING'&$orderby=createdAt desc&$top=10&$count=true

# Seleccionar solo ciertos campos
GET /odata/v4/file-proc/UploadJobs?$select=ID,fileName,status,processedLines,totalLines

# Expandir chunks (para jobs divididos)
GET /odata/v4/file-proc/UploadJobs({jobId})?$expand=chunks
```

#### Ejemplo: obtener jobs con polling (auto-refresh)

```javascript
async function loadJobs(statusFilter = null) {
  let url = '/odata/v4/file-proc/UploadJobs?$orderby=createdAt desc&$top=20&$count=true';

  if (statusFilter) {
    url += `&$filter=status eq '${statusFilter}'`;
  }

  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`Error ${res.status}`);
  const data = await res.json();

  return {
    jobs: data.value,
    totalCount: data['@odata.count']
  };
}

// Polling cada 5 segundos
setInterval(async () => {
  const { jobs } = await loadJobs();
  updateUI(jobs);
}, 5000);
```

---

## API 7 – Listar chunks de un job

### `GET /odata/v4/file-proc/JobChunks?$filter=parentJob_ID eq {jobId}`

Para jobs divididos en chunks (`isChunked = true`), consultar el progreso de cada chunk.

#### Ejemplo fetch

```javascript
async function getJobChunks(jobId) {
  const res = await fetch(
    `/odata/v4/file-proc/JobChunks?$filter=parentJob_ID eq ${jobId}&$orderby=chunkIndex asc`,
    { headers: { 'Accept': 'application/json' } }
  );
  if (!res.ok) throw new Error(`Error ${res.status}`);
  const data = await res.json();
  return data.value;
}
```

#### Respuesta (ejemplo)

```json
{
  "value": [
    {
      "ID": "...",
      "chunkIndex": 0,
      "startLine": 1,
      "endLine": 2000000,
      "totalLines": 2000000,
      "status": "DONE",
      "processedLines": 2000000,
      "claimedBy": "worker-0-a3f2",
      "durationText": "4min 12seg",
      "linesPerSecond": 7900
    },
    {
      "chunkIndex": 1,
      "startLine": 2000001,
      "endLine": 4000000,
      "totalLines": 2000000,
      "status": "PROCESSING",
      "processedLines": 1200000,
      "claimedBy": "worker-1-b5c8",
      "durationText": null,
      "linesPerSecond": 8100
    }
  ]
}
```

---

## Filtros en el frontend (archivos de SharePoint)

Las APIs de SharePoint (`listFiles`, `listFilesInFolder`) son funciones, no entidades OData, por lo que **no aceptan `$filter`**. Si necesitas filtros, aplícalos en el frontend:

```javascript
const files = await listFiles();

// Filtrar por extensión
const csvFiles = files.filter(f => f.name.endsWith('.csv'));

// Filtrar por tamaño (> 100 MB)
const largeFiles = files.filter(f => f.size > 100 * 1024 * 1024);

// Filtrar por nombre (contiene texto)
const search = 'ventas';
const matched = files.filter(f => f.name.toLowerCase().includes(search.toLowerCase()));

// Ordenar por fecha (más recientes primero)
const sorted = files.sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));

// Ordenar por tamaño (más grandes primero)
const bySize = files.sort((a, b) => b.size - a.size);
```

En cambio, las APIs de jobs (`UploadJobs`, `JobChunks`) **sí aceptan filtros OData** (`$filter`, `$orderby`, `$top`, `$skip`, `$count`, `$select`, `$expand`).

---

## Ejemplo completo: flujo típico

```javascript
// 1. Listar archivos
const files = await listFiles();

// 2. Mostrar al usuario (con filtro local)
const csvFiles = files.filter(f => f.name.endsWith('.csv'));
renderFileList(csvFiles);

// 3. Usuario hace clic en "Procesar" en un archivo
async function onProcessClick(file) {
  try {
    showSpinner(`Procesando ${file.name}...`);

    // Disparar el job
    const jobId = await createJobFromSharePoint(file);

    showSuccess(`Job creado: ${jobId}`);

    // 4. Polling del estado
    const pollInterval = setInterval(async () => {
      const job = await getJobStatus(jobId);

      updateProgressBar(job.processedBytes, job.totalBytes);
      updateStatusLabel(job.status);

      // Si terminó, parar polling
      if (['DONE', 'ERROR', 'PARTIAL_ERROR', 'CANCELED'].includes(job.status)) {
        clearInterval(pollInterval);
        hideSpinner();

        if (job.status === 'DONE') {
          showSuccess(`Completado en ${job.totalDurationText}. ${job.processedLines.toLocaleString()} líneas.`);
        } else {
          showError(job.errorMessage || 'Error desconocido');
        }
      }
    }, 3000); // Cada 3 segundos

  } catch (error) {
    hideSpinner();
    showError(error.message);
  }
}

// 5. (Opcional) Descargar archivo
async function onDownloadClick(file) {
  const { url } = await getDownloadUrl(file.itemId);
  window.open(url, '_blank');
}
```

---

## Resumen de endpoints

| # | Acción | Método | Endpoint |
|---|--------|--------|----------|
| 1 | Listar archivos (folder por defecto) | GET | `/odata/v4/sharepoint/listFiles()` |
| 2 | Listar archivos (folder específico) | GET | `/odata/v4/sharepoint/listFilesInFolder(folderId='...')` |
| 3 | Crear job (disparar workflow) | POST | `/odata/v4/sharepoint/createJobFromSharePoint` |
| 4 | Obtener URL de descarga | GET | `/odata/v4/sharepoint/getDownloadUrl(itemId='...')` |
| 5 | Consultar estado de un job | GET | `/odata/v4/file-proc/UploadJobs({jobId})` |
| 6 | Listar todos los jobs (con filtros OData) | GET | `/odata/v4/file-proc/UploadJobs` |
| 7 | Listar chunks de un job | GET | `/odata/v4/file-proc/JobChunks?$filter=parentJob_ID eq {jobId}` |

### Filtros

| Recurso | ¿Acepta filtros OData? | Solución |
|---------|------------------------|----------|
| Archivos SharePoint (`listFiles`) | **No** | Filtrar en frontend con JS |
| Jobs (`UploadJobs`) | **Sí** | `$filter`, `$orderby`, `$top`, `$skip`, `$count`, `$select`, `$expand` |
| Chunks (`JobChunks`) | **Sí** | `$filter`, `$orderby`, etc. |
