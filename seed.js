const admin = require('firebase-admin');

// Carga la service account key desde un archivo JSON descargado
const serviceAccount = require('./service-account-key.json'); // Asegúrate de que el archivo esté en el directorio raíz

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://pasalista-7a70d-default-rtdb.firebaseio.com/' // URL de tu Realtime Database
});

const db = admin.database();
const firestore = admin.firestore();

// Read the JSON file
const data = JSON.parse(fs.readFileSync('seed-alumnos-realtime.json', 'utf8'));

async function seedAlumnos() {
  try {
    // Leer datos de Realtime Database
    const ref = db.ref('alumnos');
    const snapshot = await ref.once('value');
    const alumnosData = snapshot.val();

    if (!alumnosData) {
      console.log('No hay datos en Realtime Database.');
      return;
    }

    console.log('Datos en Realtime Database:', alumnosData);
  } catch (error) {
    console.error('Error:', error);
  } finally {
    process.exit(0);
  }
}

seedAlumnos().catch(console.error);