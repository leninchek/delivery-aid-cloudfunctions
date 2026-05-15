import { onRequest } from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';

admin.initializeApp();

// ── importUsers ───────────────────────────────────────────────────────────────

const PHONE_REGEX_CF = /^\d{10}$/;
const IMPORT_MAX_ROWS = 500;
const IMPORT_AUTH_CHUNK = 100; // auth.getUsers() limit
const IMPORT_CONCURRENCY = 10; // parallel createUser calls

function parseCsvContent(content: string): string[][] {
  return content
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line =>
      line.split(',').map(cell => {
        const trimmed = cell.trim();
        return trimmed.startsWith('"') && trimmed.endsWith('"')
          ? trimmed.slice(1, -1).trim()
          : trimmed;
      })
    );
}

type ImportRow = {
  rowNum:      number;
  phone:       string;
  levelId:     string;
  parentId:    string | null;
  cityId:      string | null;
  communityId: string | null;
  routeId:     string | null;
};

type ImportError = { row: number; phone: string; reason: string };

export const importUsers = onRequest(
  { cors: true, timeoutSeconds: 540 },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method Not Allowed' });
      return;
    }

    // ── Auth ────────────────────────────────────────────────────────────────
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    try {
      const idToken      = authHeader.split('Bearer ')[1];
      const decodedToken = await admin.auth().verifyIdToken(idToken);
      const userDoc      = await admin.firestore().collection('SystemUsers').doc(decodedToken.uid).get();

      if (!userDoc.exists || userDoc.data()?.backofficeRole !== 'admin') {
        res.status(403).json({ error: 'Forbidden: Admin required' });
        return;
      }
    } catch {
      res.status(401).json({ error: 'Invalid token' });
      return;
    }

    const { csvContent } = req.body as { csvContent?: string };
    if (!csvContent?.trim()) {
      res.status(400).json({ error: 'Missing csvContent' });
      return;
    }

    // ── Parse CSV ───────────────────────────────────────────────────────────
    const rows = parseCsvContent(csvContent);
    if (rows.length < 2) {
      res.status(400).json({ error: 'El CSV no contiene filas de datos.' });
      return;
    }

    const header      = rows[0].map(h => h.toLowerCase());
    const phoneIdx    = header.indexOf('phone');
    const levelIdIdx  = header.indexOf('levelid');
    const parentIdIdx = header.indexOf('parentid');
    const cityIdIdx   = header.indexOf('cityid');
    const commIdx     = header.indexOf('communityid');
    const routeIdx    = header.indexOf('routeid');

    if (phoneIdx === -1 || levelIdIdx === -1) {
      res.status(400).json({ error: 'El CSV debe tener columnas: phone, levelId' });
      return;
    }

    const dataRows = rows.slice(1);
    if (dataRows.length > IMPORT_MAX_ROWS) {
      res.status(400).json({ error: `Máximo ${IMPORT_MAX_ROWS} filas por importación.` });
      return;
    }

    // ── Validar formato ─────────────────────────────────────────────────────
    const parseErrors: ImportError[] = [];
    const parsed: ImportRow[]        = [];
    const phoneSeen = new Set<string>();

    for (let i = 0; i < dataRows.length; i++) {
      const cols   = dataRows[i];
      const rowNum = i + 2;
      const phone  = (cols[phoneIdx] ?? '').replace(/\D/g, '');
      const levelId = cols[levelIdIdx] ?? '';

      if (!PHONE_REGEX_CF.test(phone)) {
        parseErrors.push({ row: rowNum, phone, reason: 'Teléfono inválido (debe tener 10 dígitos)' });
        continue;
      }
      if (!levelId) {
        parseErrors.push({ row: rowNum, phone, reason: 'levelId es obligatorio' });
        continue;
      }
      if (phoneSeen.has(phone)) {
        parseErrors.push({ row: rowNum, phone, reason: 'Teléfono duplicado en el CSV' });
        continue;
      }
      phoneSeen.add(phone);

      parsed.push({
        rowNum,
        phone,
        levelId,
        parentId:    parentIdIdx !== -1 ? (cols[parentIdIdx] || null)  : null,
        cityId:      cityIdIdx   !== -1 ? (cols[cityIdIdx]   || null)  : null,
        communityId: commIdx     !== -1 ? (cols[commIdx]     || null)  : null,
        routeId:     routeIdx    !== -1 ? (cols[routeIdx]    || null)  : null,
      });
    }

    // ── Verificar existencia en Firebase Auth ───────────────────────────────
    const existingErrors: ImportError[] = [];
    const newRows: ImportRow[]          = [];

    for (let i = 0; i < parsed.length; i += IMPORT_AUTH_CHUNK) {
      const chunkRows = parsed.slice(i, i + IMPORT_AUTH_CHUNK);
      const identifiers = chunkRows.map(r => ({ email: `${r.phone}@deliveryaid.app` }));
      const result      = await admin.auth().getUsers(identifiers);
      const existingSet = new Set(result.users.map(u => u.email ?? ''));

      for (const row of chunkRows) {
        if (existingSet.has(`${row.phone}@deliveryaid.app`)) {
          existingErrors.push({ row: row.rowNum, phone: row.phone, reason: 'Ya existe una cuenta con este teléfono' });
        } else {
          newRows.push(row);
        }
      }
    }

    // ── Pre-cargar paths de padres ──────────────────────────────────────────
    const uniqueParentIds = [...new Set(newRows.map(r => r.parentId).filter(Boolean) as string[])];
    const parentPathMap   = new Map<string, string[]>();

    if (uniqueParentIds.length > 0) {
      const snaps = await Promise.all(
        uniqueParentIds.map(id => admin.firestore().collection('OrgMembers').doc(id).get())
      );
      snaps.forEach((snap, idx) => {
        if (snap.exists) {
          parentPathMap.set(uniqueParentIds[idx], (snap.data()?.path as string[]) ?? []);
        }
      });
    }

    // ── Crear cuentas en Firebase Auth ──────────────────────────────────────
    const createErrors: ImportError[] = [];
    const created: { row: ImportRow; uid: string }[] = [];

    for (let i = 0; i < newRows.length; i += IMPORT_CONCURRENCY) {
      const slice   = newRows.slice(i, i + IMPORT_CONCURRENCY);
      const results = await Promise.allSettled(
        slice.map(row =>
          admin.auth().createUser({
            email:       `${row.phone}@deliveryaid.app`,
            password:    row.phone.slice(-6),
            displayName: row.phone,
          }).then(u => ({ row, uid: u.uid }))
        )
      );
      results.forEach((r, idx) => {
        if (r.status === 'fulfilled') {
          created.push(r.value);
        } else {
          const row = slice[idx];
          createErrors.push({
            row:    row.rowNum,
            phone:  row.phone,
            reason: (r.reason as Error)?.message ?? 'Error al crear cuenta en Auth',
          });
        }
      });
    }

    // ── Escritura en Firestore ──────────────────────────────────────────────
    const db            = admin.firestore();
    const SAFE_OPS      = 498; // 2 ops per user, keep under 500
    let batch           = db.batch();
    let opsInBatch      = 0;

    for (const { row, uid } of created) {
      if (opsInBatch + 2 > SAFE_OPS) {
        await batch.commit();
        batch      = db.batch();
        opsInBatch = 0;
      }

      const memberRef  = db.collection('OrgMembers').doc();
      const parentPath = row.parentId ? (parentPathMap.get(row.parentId) ?? []) : [];
      const path       = [...parentPath, memberRef.id];

      batch.set(memberRef, {
        name:       '',
        phone:      row.phone,
        curp:       '',
        birthDate:  '',
        levelId:    row.levelId,
        parentId:   row.parentId   ?? null,
        path,
        assignment: {
          cityId:      row.cityId      ?? null,
          communityId: row.communityId ?? null,
          routeId:     row.routeId     ?? null,
        },
        appUserId: uid,
        active:    true,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      batch.set(db.collection('SystemUsers').doc(uid), {
        phone:              row.phone,
        name:               '',
        type:               'app',
        backofficeRole:     null,
        orgMemberId:        memberRef.id,
        active:             true,
        mustChangePassword: true,
        onboardingComplete: false,
        createdAt:          admin.firestore.FieldValue.serverTimestamp(),
        updatedAt:          admin.firestore.FieldValue.serverTimestamp(),
      });

      opsInBatch += 2;
    }

    if (opsInBatch > 0) {
      await batch.commit();
    }

    // ── Respuesta ───────────────────────────────────────────────────────────
    const allErrors = [...parseErrors, ...existingErrors, ...createErrors]
      .sort((a, b) => a.row - b.row);

    res.status(200).json({
      total:     dataRows.length,
      succeeded: created.length,
      failed:    allErrors.length,
      errors:    allErrors,
    });
  }
);

const FCM_CHUNK_SIZE = 500;
const FIRESTORE_IN_LIMIT = 30;
const FIRESTORE_BATCH_LIMIT = 500;

const VALID_TARGETS = new Set(['all', 'level_ids']);

const STALE_TOKEN_CODES = new Set([
  'messaging/invalid-registration-token',
  'messaging/registration-token-not-registered',
  'messaging/mismatched-credential',
]);

function chunk<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

async function cleanStaleTokens(staleTokens: string[]): Promise<void> {
  if (staleTokens.length === 0) return;

  // Query in chunks of 30 (Firestore 'in' limit)
  const tokenChunks = chunk(staleTokens, FIRESTORE_IN_LIMIT);
  const snapshots = await Promise.all(
    tokenChunks.map(tokenChunk =>
      admin.firestore().collection('AppDevices')
        .where('fcmToken', 'in', tokenChunk)
        .get()
    )
  );

  const allDocs = snapshots.flatMap(s => s.docs);

  // Commit in batches of 500 (Firestore batch limit)
  const docChunks = chunk(allDocs, FIRESTORE_BATCH_LIMIT);
  await Promise.all(
    docChunks.map(docChunk => {
      const batch = admin.firestore().batch();
      docChunk.forEach(doc => {
        batch.update(doc.ref, {
          fcmToken: null,
          active: false,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      });
      return batch.commit();
    })
  );

  console.log('[sendPushCampaign] Cleaned stale tokens:', staleTokens.length);
}

async function queryTokens(target: string, targetLevelIds: string[]): Promise<string[]> {
  const seenTokens = new Set<string>();

  if (target === 'level_ids') {
    // Chunk levelIds to stay under the Firestore 'in' limit of 30
    const levelChunks = chunk(targetLevelIds, FIRESTORE_IN_LIMIT);
    const snapshots = await Promise.all(
      levelChunks.map(levelChunk =>
        admin.firestore().collection('AppDevices')
          .where('active', '==', true)
          .where('orgLevelId', 'in', levelChunk)
          .get()
      )
    );
    snapshots.flatMap(s => s.docs).forEach(doc => {
      const token = doc.data().fcmToken as string | undefined;
      if (token) seenTokens.add(token);
    });
  } else {
    const snapshot = await admin.firestore().collection('AppDevices')
      .where('active', '==', true)
      .get();
    snapshot.forEach(doc => {
      const token = doc.data().fcmToken as string | undefined;
      if (token) seenTokens.add(token);
    });
  }

  return Array.from(seenTokens);
}

// TODO: reemplazar true por el dominio del backoffice una vez que esté desplegado
// Ejemplo: { cors: ['https://backoffice.tudominio.com'] }
export const sendPushCampaign = onRequest(
  { cors: true },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method Not Allowed' });
      return;
    }

    let campaignId: string | undefined;

    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        console.warn('[sendPushCampaign] Missing or invalid Authorization header');
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const idToken = authHeader.split('Bearer ')[1];
      const decodedToken = await admin.auth().verifyIdToken(idToken);
      console.log('[sendPushCampaign] Token verified, uid:', decodedToken.uid);

      const userDoc = await admin.firestore().collection('SystemUsers').doc(decodedToken.uid).get();
      const role = userDoc.data()?.backofficeRole;
      console.log('[sendPushCampaign] User doc exists:', userDoc.exists, '| role:', role);

      if (!userDoc.exists || role !== 'admin') {
        res.status(403).json({ error: 'Forbidden: Admin required' });
        return;
      }

      const { campaignId: cid, title, body, target, targetLevelIds, screen, entityId } = req.body;
      campaignId = cid;
      console.log('[sendPushCampaign] Payload:', { campaignId, title, body, target, targetLevelIds, screen, entityId });

      if (!campaignId || !title || !body || !target) {
        res.status(400).json({ error: 'Missing required fields: campaignId, title, body, target' });
        return;
      }

      if (!VALID_TARGETS.has(target as string)) {
        res.status(400).json({ error: `Invalid target. Allowed values: ${[...VALID_TARGETS].join(', ')}` });
        return;
      }

      if (target === 'level_ids') {
        if (!Array.isArray(targetLevelIds) || targetLevelIds.length === 0) {
          res.status(400).json({ error: 'targetLevelIds must be a non-empty array when target is level_ids' });
          return;
        }
      }

      // Idempotency check + mark as in-progress in a single transaction.
      // If the campaign was already processed (or is being processed by a concurrent
      // invocation), bail out immediately to prevent double-sending.
      const TERMINAL_STATUSES = new Set(['sending', 'sent', 'partial_failed', 'failed']);
      const campaignRef = admin.firestore().collection('PushCampaigns').doc(campaignId as string);
      const alreadyProcessed = await admin.firestore().runTransaction(async (tx) => {
        const snap = await tx.get(campaignRef);
        const currentStatus = snap.data()?.status as string | undefined;
        if (currentStatus && TERMINAL_STATUSES.has(currentStatus)) {
          return true;
        }
        tx.update(campaignRef, {
          status: 'sending',
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        return false;
      });
      if (alreadyProcessed) {
        console.warn('[sendPushCampaign] Campaign already processed or in-flight, skipping:', campaignId);
        res.status(200).json({ message: 'already_processed' });
        return;
      }

      const tokens = await queryTokens(target as string, (targetLevelIds as string[]) ?? []);
      console.log('[sendPushCampaign] Tokens to send:', tokens.length);

      if (tokens.length === 0) {
        await admin.firestore().collection('PushCampaigns').doc(campaignId).update({
          status: 'failed',
          'stats.total': 0,
          'stats.sent': 0,
          'stats.failed': 0,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        res.status(200).json({ status: 'failed', total: 0, sent: 0, failed: 0 });
        return;
      }

      const baseMessage = {
        android: {
          priority: 'high' as const,
        },
        data: {
          campaignId: campaignId as string,
          title: title as string,
          body: body as string,
          screen: (screen as string) || '',
          entityId: (entityId as string) || '',
        },
      };

      // Send in batches of 500 (FCM sendEachForMulticast limit)
      let totalSent = 0;
      let totalFailed = 0;
      const staleTokens: string[] = [];

      for (const tokenChunk of chunk(tokens, FCM_CHUNK_SIZE)) {
        const response = await admin.messaging().sendEachForMulticast({
          ...baseMessage,
          tokens: tokenChunk,
        });

        totalSent += response.successCount;
        totalFailed += response.failureCount;

        response.responses.forEach((r, i) => {
          if (!r.success) {
            const code = r.error?.code ?? '';
            console.warn('[sendPushCampaign] Token failed:', code, r.error?.message);
            if (STALE_TOKEN_CODES.has(code)) {
              staleTokens.push(tokenChunk[i]);
            }
          }
        });
      }

      console.log('[sendPushCampaign] FCM result:', { total: tokens.length, sent: totalSent, failed: totalFailed });

      try {
        await cleanStaleTokens(staleTokens);
      } catch (cleanError) {
        // Non-fatal: stale token cleanup failing should not block the campaign status update
        console.error('[sendPushCampaign] Failed to clean stale tokens:', cleanError);
      }

      let status: string;
      if (totalFailed === 0) {
        status = 'sent';
      } else if (totalSent > 0) {
        status = 'partial_failed';
      } else {
        status = 'failed';
      }

      await admin.firestore().collection('PushCampaigns').doc(campaignId).update({
        status,
        sentAt: admin.firestore.FieldValue.serverTimestamp(),
        'stats.total': tokens.length,
        'stats.sent': totalSent,
        'stats.failed': totalFailed,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      res.status(200).json({ status, total: tokens.length, sent: totalSent, failed: totalFailed });

    } catch (error) {
      console.error('[sendPushCampaign] Unhandled error:', error);
      if (campaignId) {
        try {
          await admin.firestore().collection('PushCampaigns').doc(campaignId).update({
            status: 'failed',
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        } catch (updateError) {
          console.error('[sendPushCampaign] Failed to mark campaign as failed:', updateError);
        }
      }
      res.status(500).json({ error: 'Internal Server Error' });
    }
  }
);

// ── Shared auth helper ────────────────────────────────────────────────────────

async function verifyAdmin(req: { headers: { authorization?: string } }): Promise<string> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) throw Object.assign(new Error('Unauthorized'), { status: 401 });

  const idToken = authHeader.split('Bearer ')[1];
  const decoded = await admin.auth().verifyIdToken(idToken);

  const userDoc = await admin.firestore().collection('SystemUsers').doc(decoded.uid).get();
  if (!userDoc.exists || userDoc.data()?.backofficeRole !== 'admin') {
    throw Object.assign(new Error('Forbidden: Admin required'), { status: 403 });
  }
  return decoded.uid;
}

// ── createAppUser ─────────────────────────────────────────────────────────────

export const createAppUser = onRequest(
  { cors: true },
  async (req, res) => {
    if (req.method !== 'POST') { res.status(405).json({ error: 'Method Not Allowed' }); return; }

    try {
      await verifyAdmin(req);

      const { phone, levelId, parentId, cityId, communityId, routeId } = req.body as {
        phone: string; levelId: string;
        parentId?: string | null; cityId?: string | null;
        communityId?: string | null; routeId?: string | null;
      };

      if (!PHONE_REGEX_CF.test(phone)) {
        res.status(400).json({ error: 'El teléfono debe tener exactamente 10 dígitos.' }); return;
      }
      if (!levelId?.trim()) {
        res.status(400).json({ error: 'El nivel organizacional es obligatorio.' }); return;
      }

      const email = `${phone}@deliveryaid.app`;
      const tempPassword = phone.slice(-6);

      try {
        await admin.auth().getUserByEmail(email);
        res.status(409).json({ error: 'Ya existe una cuenta con ese número de teléfono.' }); return;
      } catch (lookupErr: unknown) {
        if ((lookupErr as { code?: string }).code !== 'auth/user-not-found') throw lookupErr;
      }

      const authUser = await admin.auth().createUser({ email, password: tempPassword, displayName: phone });
      const uid = authUser.uid;

      const memberRef = admin.firestore().collection('OrgMembers').doc();
      let path: string[] = [memberRef.id];
      if (parentId) {
        const parentSnap = await admin.firestore().collection('OrgMembers').doc(parentId).get();
        const parentPath = (parentSnap.data()?.path as string[] | undefined) ?? [];
        path = [...parentPath, memberRef.id];
      }

      const batch = admin.firestore().batch();
      batch.set(memberRef, {
        name: '', phone, curp: '', birthDate: '', levelId,
        parentId: parentId ?? null, path,
        assignment: { cityId: cityId ?? null, communityId: communityId ?? null, routeId: routeId ?? null },
        appUserId: uid, active: true,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      batch.set(admin.firestore().collection('SystemUsers').doc(uid), {
        phone, name: '', type: 'app', backofficeRole: null,
        orgMemberId: memberRef.id, active: true,
        mustChangePassword: true, onboardingComplete: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      await batch.commit();

      res.status(201).json({ uid, phone, tempPassword });

    } catch (err: unknown) {
      const status = (err as { status?: number }).status ?? 500;
      const message = err instanceof Error ? err.message : 'Error interno al crear el usuario.';
      console.error('[createAppUser]', err);
      res.status(status).json({ error: message });
    }
  }
);

// ── resetAppUserPassword ──────────────────────────────────────────────────────

const RESET_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generateTempPassword(): string {
  let result = '';
  for (let i = 0; i < 8; i++) result += RESET_CHARS[Math.floor(Math.random() * RESET_CHARS.length)];
  return result;
}

export const resetAppUserPassword = onRequest(
  { cors: true },
  async (req, res) => {
    if (req.method !== 'POST') { res.status(405).json({ error: 'Method Not Allowed' }); return; }

    try {
      await verifyAdmin(req);

      const { uid } = req.body as { uid: string };
      if (!uid?.trim()) { res.status(400).json({ error: 'El uid es obligatorio.' }); return; }

      const tempPassword = generateTempPassword();
      await admin.auth().updateUser(uid, { password: tempPassword });
      await admin.firestore().collection('SystemUsers').doc(uid).update({
        mustChangePassword: true,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      res.status(200).json({ tempPassword });

    } catch (err: unknown) {
      const status = (err as { status?: number }).status ?? 500;
      const message = err instanceof Error ? err.message : 'Error interno al restablecer la contraseña.';
      console.error('[resetAppUserPassword]', err);
      res.status(status).json({ error: message });
    }
  }
);

// ── toggleAppUserStatus ───────────────────────────────────────────────────────

export const toggleAppUserStatus = onRequest(
  { cors: true },
  async (req, res) => {
    if (req.method !== 'POST') { res.status(405).json({ error: 'Method Not Allowed' }); return; }

    try {
      await verifyAdmin(req);

      const { uid, active } = req.body as { uid: string; active: boolean };
      if (!uid?.trim()) { res.status(400).json({ error: 'El uid es obligatorio.' }); return; }
      if (typeof active !== 'boolean') { res.status(400).json({ error: 'El campo active debe ser un booleano.' }); return; }

      await Promise.all([
        admin.auth().updateUser(uid, { disabled: !active }),
        admin.firestore().collection('SystemUsers').doc(uid).update({
          active,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }),
      ]);

      res.status(200).json({ ok: true });

    } catch (err: unknown) {
      const status = (err as { status?: number }).status ?? 500;
      const message = err instanceof Error ? err.message : 'Error interno al cambiar el estado.';
      console.error('[toggleAppUserStatus]', err);
      res.status(status).json({ error: message });
    }
  }
);
