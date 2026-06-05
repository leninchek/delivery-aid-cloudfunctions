# Delivery Aid — Cloud Functions

Funciones HTTP de Firebase para operaciones que requieren privilegios de Firebase Admin SDK. Actúan como backend seguro para el Back Office (que se despliega como export estático sin servidor) y para la App Android.

---

## Stack tecnológico

| Categoría | Tecnología | Versión |
|---|---|---|
| Runtime | Node.js | 22 |
| Lenguaje | TypeScript | 5.x |
| Framework | Firebase Functions v2 | 7.x |
| Admin SDK | firebase-admin | 13.x |

---

## Funciones expuestas

### `POST /importUsers`

Importa cuentas App en lote desde un CSV.

**Acceso:** Solo `admin` (verifica `SystemUsers.backofficeRole`)

**Body:**
```json
{ "csvContent": "phone,levelId,parentId,cityId,communityId,routeId\n..." }
```

**Columnas CSV:**
| Columna | Obligatorio | Descripción |
|---|---|---|
| `phone` | Sí | 10 dígitos, se convierte en email `{phone}@deliveryaid.app` |
| `levelId` | Sí | ID de `OrgLevels` |
| `parentId` | No | ID de `OrgMembers` del superior directo |
| `cityId` | No | ID de `Cities` |
| `communityId` | No | ID de `Communities` |
| `routeId` | No | ID de `Routes` |

**Comportamiento:**
- Máximo 500 filas por importación.
- Verifica duplicados en Firebase Auth antes de crear.
- Crea en Firebase Auth con contraseña temporal = últimos 6 dígitos del teléfono.
- Crea documentos en `OrgMembers` y `SystemUsers` en batch atómico.
- Retorna resumen: `{ total, succeeded, failed, errors[] }`.

---

### `POST /createAppUser`

Crea una sola cuenta App para un miembro del organigrama.

**Acceso:** Solo `admin`

**Body:**
```json
{
  "phone": "9981234567",
  "levelId": "<id>",
  "parentId": "<id_opcional>",
  "cityId": "<id_opcional>",
  "communityId": "<id_opcional>",
  "routeId": "<id_opcional>"
}
```

**Comportamiento:**
- Email generado: `{phone}@deliveryaid.app`
- Contraseña temporal: últimos 6 dígitos del teléfono.
- Marca `mustChangePassword: true` y `onboardingComplete: false` en `SystemUsers`.
- Retorna `{ uid, phone, tempPassword }`.

---

### `POST /resetAppUserPassword`

Genera una contraseña temporal nueva para una cuenta App existente.

**Acceso:** Solo `admin`

**Body:**
```json
{ "uid": "<firebase_auth_uid>" }
```

**Comportamiento:**
- Genera contraseña aleatoria de 8 caracteres (sin caracteres ambiguos).
- Actualiza Firebase Auth y marca `mustChangePassword: true` en `SystemUsers`.
- Retorna `{ tempPassword }`.

---

### `POST /toggleAppUserStatus`

Activa o desactiva una cuenta App.

**Acceso:** Solo `admin`

**Body:**
```json
{ "uid": "<firebase_auth_uid>", "active": true }
```

**Comportamiento:**
- Actualiza `disabled` en Firebase Auth.
- Actualiza `active` en `SystemUsers`.

---

### `POST /sendPushCampaign`

Envía una campaña de notificaciones push a usuarios de la App.

**Acceso:** Solo `admin`

**Body:**
```json
{
  "campaignId": "<id_de_PushCampaigns>",
  "title": "Título de la notificación",
  "body": "Mensaje de la notificación",
  "target": "all",
  "targetLevelIds": [],
  "screen": "home",
  "entityId": ""
}
```

**Campos `target`:**
- `all` — Todos los dispositivos activos en `AppDevices`.
- `level_ids` — Solo dispositivos de usuarios con nivel en `targetLevelIds`.

**Comportamiento:**
- Verificación de idempotencia: si la campaña ya está en estado terminal (`sending`, `sent`, `partial_failed`, `failed`), no reenvía.
- Envía en lotes de 500 tokens (límite de FCM `sendEachForMulticast`).
- Limpia tokens inválidos en `AppDevices` después del envío.
- Actualiza `PushCampaigns` con estado final y estadísticas (`stats.total`, `stats.sent`, `stats.failed`).
- Estados de resultado: `sent` / `partial_failed` / `failed`.

---

## Autenticación

Todas las funciones requieren:

```
Authorization: Bearer <id_token>
```

El `id_token` se obtiene de Firebase Auth en el cliente (Back Office). La función verifica:
1. Token válido y no expirado.
2. Documento en `SystemUsers/{uid}` con `backofficeRole === "admin"`.

---

## Colecciones Firestore accedidas

| Colección | Operaciones |
|---|---|
| `SystemUsers` | Lectura (verificar admin), escritura (crear/actualizar usuarios App) |
| `OrgMembers` | Lectura (resolver paths), escritura (crear miembros en importación) |
| `AppDevices` | Lectura (obtener tokens FCM), escritura (desactivar tokens inválidos) |
| `PushCampaigns` | Lectura + escritura (estado y estadísticas) |

---

## Configuración y despliegue

### Requisitos

- Node.js 22
- Firebase CLI instalado: `npm install -g firebase-tools`
- Proyecto Firebase configurado en `firebase.json` y `.firebaserc`

### Instalación

```bash
cd Delivery-Aid-CloudFunctions
npm install
```

### Compilar

```bash
npm run build
```

### Emulador local

```bash
npm run serve
# Levanta el emulador de Cloud Functions en localhost
```

### Despliegue

```bash
# Desplegar a producción (por defecto)
firebase deploy --only functions

# Desplegar a QA
firebase deploy -P qa --only functions
```

### Ambientes Firebase

| Alias | Proyecto Firebase | URL base de funciones |
|---|---|---|
| `default` / `production` | `delivery-aid` | `https://us-central1-delivery-aid.cloudfunctions.net` |
| `qa` | `delivery-aid-qa` | `https://us-central1-delivery-aid-qa.cloudfunctions.net` |

La configuración de ambientes está en `.firebaserc` en la raíz del workspace.

> Las funciones v2 también son accesibles vía Cloud Run URL (formato `https://<fn>-<hash>-uc.a.run.app`). Ambas URLs funcionan para la misma función.

### Cleanup policy

Configurada en ambos proyectos — imágenes de contenedor antiguas (>1 día) se eliminan automáticamente para evitar acumulación de costos de Storage.

### Ver logs en producción

```bash
npm run logs
```

---

## Notas de seguridad

- El CORS está restringido a los dominios autorizados en las 5 funciones:
  - `https://cuentaconmigo.chemachacon.com.mx` (producción)
  - `https://delivery-aid-qa.web.app` (QA)
  - `https://delivery-aid-qa.firebaseapp.com` (QA alternativo)
- Las funciones nunca exponen credenciales de Firebase Admin al cliente.
- La contraseña temporal de nuevos usuarios App se entrega solo al admin que la solicita y no se guarda en texto claro en Firestore.
