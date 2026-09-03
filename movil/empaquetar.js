/**
 * Arma el .apk que se le pasa a cada asesor.
 *
 *   npm run empaquetar
 *
 * La app NO trae la bandeja adentro: abre la que sirve el servidor, igual que
 * la de Windows. Así, actualizar el servidor actualiza a todos, y este .apk
 * sólo hay que repartirlo de nuevo si cambia el envoltorio —permisos, ícono,
 * la dirección del servidor—, que casi nunca pasa.
 *
 * La primera corrida crea la firma en `firma/`. Ese directorio no está en git y
 * hay que respaldarlo: sin él, un teléfono que ya tenga WhatsWV instalado NO
 * acepta la actualización — Android la ve como una app distinta y obliga a
 * desinstalar, con lo que el asesor pierde la sesión.
 */
const { execFileSync } = require('node:child_process');
const {
  existsSync,
  mkdirSync,
  copyFileSync,
  writeFileSync,
  readFileSync,
  readdirSync,
} = require('node:fs');
const { join } = require('node:path');
const { randomBytes } = require('node:crypto');

const AQUI = __dirname;
const ANDROID = join(AQUI, 'android');
const FIRMA = join(AQUI, 'firma');
const SALIDA = join(AQUI, 'salida');

/**
 * Java 21: es el que pide Capacitor 7, con el 17 la compilación falla.
 *
 * Se mira tanto donde lo deja el instalador como C:\Android\jdk21, que es donde
 * termina si se baja el .zip. El .zip es la vía que funciona sin permisos de
 * administrador: el instalador de winget se cuelga esperando un cuadro de UAC
 * que en una sesión sin escritorio nadie ve.
 */
function buscarJdk() {
  if (process.env.JAVA_HOME && existsSync(join(process.env.JAVA_HOME, 'bin', 'java.exe'))) {
    return process.env.JAVA_HOME;
  }

  const donde = [
    join(process.env.ProgramFiles ?? 'C:/Program Files', 'Eclipse Adoptium'),
    'C:/Android/jdk21',
  ];

  for (const base of donde) {
    if (!existsSync(base)) continue;
    const jdk21 = readdirSync(base).find((d) => /jdk-?21/.test(d));
    if (jdk21) return join(base, jdk21);
  }

  throw new Error(
    'No encontré un JDK 21. Se baja de:\n' +
      '  https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jdk/hotspot/normal/eclipse\n' +
      'y se descomprime en C:/Android/jdk21',
  );
}

function buscarSdk() {
  for (const ruta of [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    'C:/Android/Sdk',
    join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk'),
  ]) {
    if (ruta && existsSync(ruta)) return ruta;
  }
  throw new Error('No encontré el SDK de Android. Viene con Android Studio.');
}

/** La crea una sola vez; después se reusa siempre la misma. */
function asegurarFirma(jdk) {
  const propiedades = join(FIRMA, 'clave.properties');
  if (existsSync(propiedades)) return;

  mkdirSync(FIRMA, { recursive: true });

  // Generada, no elegida: una clave escrita a mano en un archivo que igual hay
  // que respaldar no protege más y se olvida.
  const clave = randomBytes(18).toString('base64url');
  const almacen = 'whatswv.keystore';

  console.log('  no había firma: creando una nueva\n');
  execFileSync(
    join(jdk, 'bin', 'keytool.exe'),
    [
      '-genkeypair',
      '-keystore',
      join(FIRMA, almacen),
      '-alias',
      'whatswv',
      '-keyalg',
      'RSA',
      '-keysize',
      '2048',
      '-validity',
      '10000',
      '-storepass',
      clave,
      '-keypass',
      clave,
      '-dname',
      'CN=Repuestos Volkswagen Jhon Pardo, O=Repuestos Volkswagen Jhon Pardo, L=Bogota, C=CO',
    ],
    { stdio: 'inherit' },
  );

  writeFileSync(
    propiedades,
    '# Firma de la app. NO va al repositorio y hay que respaldarla:\n' +
      '# sin este archivo no se puede actualizar una instalación existente.\n' +
      `almacen=${almacen}\n` +
      `claveAlmacen=${clave}\n` +
      'alias=whatswv\n' +
      `claveClave=${clave}\n`,
  );
}

/**
 * Escribe la versión en los dos sitios que la necesitan.
 *
 * En el User-Agent porque es como la bandeja sabe qué versión tiene el teléfono
 * delante: la app abre la web del servidor, así que sin esto la página no puede
 * distinguir un celular con la app vieja de uno recién instalado, y no puede
 * avisar de que hay una nueva.
 *
 * Y en build.gradle para que la ficha de la app en Android diga la verdad. Las
 * dos salen de package.json y no escritas a mano en tres archivos, que es como
 * terminan diciendo tres cosas distintas.
 */
function ponerVersion() {
  const paquete = JSON.parse(readFileSync(join(AQUI, 'package.json'), 'utf8'));
  const version = paquete.version;

  const rutaConfig = join(AQUI, 'capacitor.config.json');
  const config = JSON.parse(readFileSync(rutaConfig, 'utf8'));
  config.android = { ...config.android, appendUserAgent: `WhatsWV/${version}` };
  writeFileSync(rutaConfig, `${JSON.stringify(config, null, 2)}\n`);

  // El código de versión tiene que crecer con cada publicación o Android se
  // niega a instalar encima. Se arma con los números de la versión.
  const [may, men, par] = version.split('.').map(Number);
  const codigo = may * 10000 + men * 100 + par;

  const rutaGradle = join(ANDROID, 'app', 'build.gradle');
  const gradle = readFileSync(rutaGradle, 'utf8')
    .replace(/versionCode \d+/, `versionCode ${codigo}`)
    .replace(/versionName "[^"]*"/, `versionName "${version}"`);
  writeFileSync(rutaGradle, gradle);

  console.log(`  versión: ${version} (código ${codigo})`);
  return version;
}

function main() {
  const jdk = buscarJdk();
  const sdk = buscarSdk();
  console.log(`  jdk: ${jdk}`);
  console.log(`  sdk: ${sdk}\n`);

  // Con barras hacia adelante: en un archivo .properties la barra invertida es
  // un escape, y la ruta llega partida.
  const sdkGradle = sdk.split(/[\\/]/).join('/');
  writeFileSync(join(ANDROID, 'local.properties'), `sdk.dir=${sdkGradle}\n`);

  ponerVersion();
  asegurarFirma(jdk);

  // `cap sync` deja en android/ la configuración y los assets, que están fuera
  // de git porque los genera Capacitor. Sin este paso, un clon recién bajado
  // compila un .apk sin la dirección del servidor adentro.
  console.log('  sincronizando la configuración…\n');
  execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/c', 'npx', 'cap', 'sync', 'android'], {
    cwd: AQUI,
    stdio: 'inherit',
  });

  console.log('\n  compilando…\n');
  // Por cmd y no directo: Windows no sabe ejecutar un .bat sin intérprete, y
  // llamarlo por nombre con el cwd puesto evita tener que entrecomillar una
  // ruta que trae una Ñ y espacios.
  execFileSync(
    process.env.ComSpec ?? 'cmd.exe',
    ['/c', '.\\gradlew.bat', 'assembleRelease', '--no-daemon'],
    {
      cwd: ANDROID,
      env: { ...process.env, JAVA_HOME: jdk, ANDROID_HOME: sdk },
      stdio: 'inherit',
    },
  );

  const apk = join(ANDROID, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
  if (!existsSync(apk)) throw new Error('la compilación no dejó el .apk donde se esperaba');

  mkdirSync(SALIDA, { recursive: true });
  const destino = join(SALIDA, 'WhatsWV.apk');
  copyFileSync(apk, destino);

  console.log(`\n  listo: ${destino}`);
}

try {
  main();
} catch (e) {
  console.error(`\n  ${e.message}\n`);
  process.exit(1);
}
