# Delivery Aid Cloud Functions

Firebase Cloud Functions para el proyecto Delivery Aid.

## Funciones

- `sendPushCampaign`: Envía campañas de notificaciones push a usuarios de la App Android.

## Despliegue

1. Instalar dependencias: `npm install`
2. Compilar: `npm run build`
3. Desplegar: `firebase deploy --only functions`

## Configuración

- Asegúrate de que `firebase.json` y `.firebaserc` estén configurados con el ID del proyecto Firebase.
- La función requiere permisos de Firestore para leer `SystemUsers` y `AppDevices`.

## Testing

- Emulador local: `npm run serve`
- Logs: `npm run logs`