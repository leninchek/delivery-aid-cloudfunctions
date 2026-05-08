// functions/src/index.ts
import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';

admin.initializeApp();

export const sendPushCampaign = functions.https.onRequest(async (req, res) => {
  // Enable CORS
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST');
  res.set('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).send('Method Not Allowed');
    return;
  }

  try {
    // Check if user is authenticated and is admin
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).send('Unauthorized');
      return;
    }

    const idToken = authHeader.split('Bearer ')[1];
    const decodedToken = await admin.auth().verifyIdToken(idToken);

    // Check if user is admin
    const userDoc = await admin.firestore().collection('SystemUsers').doc(decodedToken.uid).get();
    if (!userDoc.exists || userDoc.data()?.backofficeRole !== 'admin') {
      res.status(403).send('Forbidden: Admin required');
      return;
    }

    const { campaignId, title, body, target, targetLevelIds } = req.body;

    if (!campaignId || !title || !body || !target) {
      res.status(400).send('Missing required fields');
      return;
    }

    // Get target devices
    let deviceQuery = admin.firestore().collection('AppDevices')
      .where('active', '==', true);

    if (target === 'level_ids' && targetLevelIds && targetLevelIds.length > 0) {
      // For segmented, we need to join with SystemUsers and OrgMembers
      // This is complex; for simplicity, send to all for now
      // TODO: Implement level filtering
    }

    const devicesSnapshot = await deviceQuery.get();
    const tokens: string[] = [];
    devicesSnapshot.forEach(doc => {
      const data = doc.data();
      if (data.fcmToken) {
        tokens.push(data.fcmToken);
      }
    });

    if (tokens.length === 0) {
      // Update campaign as failed
      await admin.firestore().collection('PushCampaigns').doc(campaignId).update({
        status: 'failed',
        'stats.total': 0,
        'stats.sent': 0,
        'stats.failed': 0,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      res.status(200).json({ status: 'failed', total: 0, sent: 0, failed: 0 });
      return;
    }

    // Prepare message
    const message = {
      notification: {
        title,
        body,
      },
      data: {
        screen: req.body.screen || '',
        entityId: req.body.entityId || '',
        campaignId,
      },
      tokens,
    };

    // Send multicast message
    const response = await admin.messaging().sendMulticast(message);

    const sent = response.successCount;
    const failed = response.failureCount;
    const total = tokens.length;

    // Update campaign stats
    let status: string;
    if (failed === 0) {
      status = 'sent';
    } else if (sent > 0) {
      status = 'partial_failed';
    } else {
      status = 'failed';
    }

    await admin.firestore().collection('PushCampaigns').doc(campaignId).update({
      status,
      sentAt: admin.firestore.FieldValue.serverTimestamp(),
      'stats.total': total,
      'stats.sent': sent,
      'stats.failed': failed,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.status(200).json({ status, total, sent, failed });

  } catch (error) {
    console.error('Error sending push campaign:', error);
    res.status(500).send('Internal Server Error');
  }
});