# AR-VR-test · XR Test Bench

Banco de pruebas para medir, con números y no con impresiones, qué se puede
hacer realmente con **un teléfono Android + un visor tipo Cardboard de plástico
(VR Box) con apertura para la cámara**.

Es una sola página web sin build. Se abre la misma URL en los dos modos —
teléfono en la mano y teléfono dentro del visor — y los resultados quedan
guardados y exportables en JSON, así que los dos escenarios son comparables.

## Qué mide

| Test | Qué responde | Métrica principal |
|---|---|---|
| 👁️ **1 · Visibilidad** | ¿Qué tan chico puedo hacer un elemento y que siga siendo legible? | Agudeza en minutos de arco (anillos de Landolt, 4 opciones), umbral de contraste, resolución angular en ′/píxel |
| 🤌 **2 · Manos** | ¿Con cuánta precisión puedo apuntar y confirmar con la mano? | Error de puntería en grados y en mm, tiempo de adquisición, jitter, tasa de tracking, pinches espurios |
| 📐 **3 · AR** | ¿Qué tanto se quedan quietos los elementos anclados al mundo? | Error de colocación en mm, deriva del anclaje en mm, error de escala en % |

## Cómo se arma este visor como headset

Un VR Box no tiene hand tracking, ni controladores, ni WebXR `immersive-vr`.
Lo que sí tiene es un teléfono adentro y un agujero para la cámara, así que el
banco construye las tres piezas por su cuenta:

- **Estéreo**: dos render targets con pre-distorsión de barril propia
  (`js/stereo.js`), para cancelar la distorsión en almohadilla de la lente.
  Cada ojo se renderiza con el frustum **descentrado hacia la nariz**, para que
  su eje óptico caiga sobre el centro de la lente y no sobre el centro de su
  media pantalla: es lo que decide si la imagen fusiona (ver *Que la imagen
  fusione*, más abajo). Separación de imágenes, IPD, FOV, k1, k2 y aberración
  cromática son ajustables en vivo, y los tres primeros también desde adentro
  del visor.
- **Tracking de cabeza**: 3DOF por `DeviceOrientationEvent` (`js/orientation.js`).
  No hay posición, solo rotación: es lo que da el hardware.
- **Passthrough**: la cámara trasera dibujada como fondo de los dos ojos.
  Es *monoscópico* — las dos lentes ven la misma imagen — así que el mundo real
  se percibe plano, sin profundidad. Es una limitación del hardware, no un bug.
- **Manos**: MediaPipe Hand Landmarker sobre ese mismo feed (`js/hands.js`).
  Pinch = distancia índice-pulgar normalizada por el tamaño de la mano.

## Correrlo

Necesita **HTTPS** (o `localhost`): sin eso no hay cámara, ni sensores, ni WebXR.

**Opción rápida — GitHub Pages**

1. Settings → Pages → Source: *Deploy from a branch* → rama `main`, carpeta `/`.
2. Abrir la URL que queda publicada, desde Chrome en Android.

**Opción local**

```bash
npx http-server -p 8080          # en la computadora
# el teléfono por USB, con depuración activada:
adb reverse tcp:8080 tcp:8080    # y abrir http://localhost:8080 en el teléfono
```

`localhost` cuenta como contexto seguro, así que funciona todo sin certificado.

## Que la imagen fusione

Es el primer problema a resolver, antes que la nitidez y antes que la
distorsión, y no se arregla con la IPD.

Tu ojo mira a través del **centro de su lente**: lo que ve "de frente" es el
píxel que está sobre el eje de esa lente, no el píxel del centro de su media
pantalla. En un teléfono de 140 mm de ancho, los centros de las dos medias
pantallas están a 70 mm uno del otro, pero las lentes están a 63 mm. Si cada
imagen se dibuja centrada en su media pantalla, el "adelante" de cada ojo cae
**3,5 mm más afuera** de donde tiene que caer. A través de una lente de unos
40 mm de focal, esos 3,5 mm son unos **5° de divergencia por ojo**, y el ojo
humano tolera bastante menos de 1°: para juntar las dos imágenes tendría que
mirar hacia afuera, cosa que no hace. Se ve doble, y a los dos minutos duele la
cabeza.

Por eso el parámetro que hay que ajustar primero es **separación de las dos
imágenes** (`imgSep`), en % del ancho total de la pantalla:

```
imgSep % = separación entre los centros de tus lentes ÷ ancho de la pantalla × 100
         = 63 mm ÷ 140 mm × 100 ≈ 45 %
```

Si no querés medir nada, se ajusta a ojo desde adentro del visor con
**👁️ Ajustar dentro del visor**: en el centro hay un blanco con un anillo que
ven los dos ojos y dos barras cortas, una **naranja arriba que ve solo el ojo
izquierdo** y una **verde abajo que ve solo el derecho**. Con la separación
correcta las dos caen en una única línea vertical; si están corridas, tocá
`◀ juntar` o `separar ▶` (se seleccionan con la mirada) hasta alinearlas.

La **IPD** es otra cosa: solo controla la paralaje entre los dos ojos, o sea la
sensación de profundidad de los objetos cercanos. No arregla la fusión.

## Orden recomendado la primera vez

1. **⚙️ Calibración**, con el teléfono en la mano:
   - Cargá la **separación de las dos imágenes** con la cuenta de arriba, o
     dejala en 45 % y afinala después dentro del visor.
   - Medí con una regla el **alto físico** del área visible de la pantalla y
     cargalo. Sin ese dato, los grados del modo pantalla son inventados y las
     dos columnas de resultados no se pueden comparar.
   - Poné tu **IPD**.
2. **👁️ Ajustar dentro del visor**, con el teléfono ya en el visor:
   - alineá primero las barras naranja y verde (fusión);
   - después subí `k1` hasta que las líneas rectas se vean rectas, y `chroma`
     hasta que se vayan las franjas de color de los bordes.
3. Corré **Test 1 en pantalla** y después **Test 1 en el visor**. La diferencia
   entre los dos números es el costo real de meter el teléfono en el visor.
4. **Test 2** primero en pantalla (es más fácil calibrar el FOV de la cámara
   viendo la pantalla) y después en el visor.
5. **Test 3** con el teléfono en la mano; necesita ARCore.
6. **📊 Resultados → Descargar JSON**.

## Cómo se selecciona

- **En la mano**: se toca la pantalla.
- **En el visor**: retícula al centro + *dwell* — mirás el botón y sostenés
  ~1,2 s (ajustable). Cualquier tecla o botón de un mando bluetooth también
  activa lo que esté enfocado.

## Leer los resultados

- `acuityGapArcmin` — el hueco más chico del anillo que distinguiste. Un hueco
  de 1′ equivale a visión 20/20; **6′ ≈ 20/120**. En estos visores es normal
  caer entre 5′ y 12′.
- `arcminPerPixel` — resolución angular teórica del display en ese modo
  (FOV ÷ píxeles). La agudeza medida nunca puede ser mejor que ~2× este valor:
  si te da igual, estás limitado por los píxeles; si te da mucho peor, el
  cuello de botella es la lente o el enfoque.
- `minLegibleTextArcmin` — regla práctica derivada (`agudeza × 5 × 1,4`):
  altura mínima de texto para que se lea cómodo. Es la que te dice cuántos
  grados tiene que ocupar un botón.
- `errDeg` / `errMmAt50cm` del Test 2 — el mismo error expresado en grados y en
  milímetros a 50 cm de la mano. El segundo es el que te dice si podés hacer un
  botón de 2 cm o si tiene que ser de 8.
- `driftMm` del Test 3 — cuánto se movió el mundo virtual después de un paseo.
  Es el número que decide si podés anclar algo a una mesa o no.

## Limitaciones conocidas

Vale la pena tenerlas a la vista antes de sacar conclusiones:

- **El passthrough es monoscópico.** Los dos ojos ven la misma imagen de cámara.
  Por eso los objetivos del Test 2 se dibujan lejos (10 m): así la paralaje
  estéreo no los despega de la mano real. No esperes profundidad del mundo real.
- **El tracking de cabeza es 3DOF.** Rotación sí, traslación no. Si te movés,
  el mundo virtual se mueve con vos.
- **El Test 2 mide la cadena completa**, no solo MediaPipe: cámara + detección +
  tu puntería + la latencia del render. Es a propósito: eso es lo que va a
  sentir el usuario.
- **El Test 3 mide colocación end-to-end**, que incluye tu puntería. Para
  separar el error del tracking del error humano, mirá `driftMm` (tarea B), que
  no depende de apuntar bien dos veces al mismo píxel sino al mismo punto físico.
- **El umbral de contraste tiene piso ~2%** por la cuantización de 8 bits del
  panel. Cada ensayo registra `codeStep`: si es 0 o 1, el estímulo estaba en el
  límite de lo representable.
- **La agudeza usa 2 ensayos por tamaño**, con todos los tamaños fijos (no es
  una escalera adaptativa). El umbral es el hueco más chico con 100% de
  aciertos en su serie; no exige que sea una racha continua desde el tamaño
  más grande, así que un tropiezo aislado en un tamaño grueso no invalida
  aciertos perfectos en tamaños más finos. Es rápida, no clínica: mirá
  `acuityLadder` en el JSON si un resultado te resulta raro — ahí está el
  detalle nivel por nivel. Lo mismo aplica al umbral de contraste, con la
  salvedad de que ahí hay un solo ensayo por nivel (más sensible a la suerte).
- **iOS no corre esto.** Safari no tiene WebXR y `DeviceOrientationEvent`
  necesita permiso explícito. Está pensado para Chrome en Android.

## Si el Test 3 no arranca

`The specified session configuration is not supported` es el mensaje único que
Chrome da para cualquier problema al abrir la sesión: no dice qué feature
molestó. El banco prueba entonces varias configuraciones, de la más completa a
la más pobre, y si ninguna entra imprime en la pantalla de inicio qué falló en
cada intento y con qué error. Lo más común, por orden:

1. **Falta ARCore.** `isSessionSupported('immersive-ar')` devuelve `true` en
   cualquier Android que *podría* soportarlo, y recién `requestSession()`
   descubre que "Servicios de Google Play para RA" no está instalado o está
   viejo. Instalalo o actualizalo desde Play Store y abrilo una vez.
2. **El teléfono no está certificado por ARCore.** La lista está en
   [developers.google.com/ar/devices](https://developers.google.com/ar/devices).
   Muchos de gama de entrada no están, y desde la web no hay nada que hacer.
3. **Se canceló un diálogo** (permiso de cámara, o la instalación de ARCore).
   Si el intento tardó segundos antes de fallar, fue esto: el banco lo detecta,
   no reintenta para no volver a molestarte, y te lo dice.
4. **Sin HTTPS**, o la página abierta dentro del navegador embebido de otra app.

Si la sesión abre pero el dispositivo no concede todo:

- **sin `hit-test`** el test corre igual, cambiando la puntería: en vez de
  apuntar a una superficie, se marca el punto **apoyando el borde de arriba del
  teléfono contra él**. La deriva y la escala se miden igual de bien, porque solo
  dependen del tracking 6DOF.
- **sin `dom-overlay`** el DOM es invisible adentro de la sesión, así que la UI
  se dibuja en 3D y se selecciona con la mirada. La tarea C (escala) queda
  deshabilitada: necesita escribir la medida real con el teclado.

## Estructura

```
index.html            paneles DOM y el import map
css/style.css
js/main.js            orquestador: modos, sesión WebXR, paneles
js/stereo.js          render mono/estéreo + distorsión de barril + passthrough
js/orientation.js     tracking de cabeza 3DOF
js/camerafeed.js      cámara trasera: textura de fondo y entrada del detector
js/hands.js           MediaPipe Hand Landmarker
js/interaction.js     selección por mirada+dwell o por toque
js/layout.js          UI en coordenadas de pantalla (el FOV cambia mucho por modo)
js/textures.js        texturas de canvas: texto, anillos de Landolt, rejilla
js/logger.js          registro de resultados y exportación
js/config.js          parámetros de calibración persistidos
js/tests/*.js         los tres tests
```

Nota sobre color: `ColorManagement` de three.js va **apagado** y
`outputColorSpace` en lineal, a propósito. Trabajamos en valores de display
crudos para que un gris 128 llegue al panel como 128; si no, el test de
contraste terminaría midiendo la gestión de color de three.js en vez de la
pantalla.

Para depurar desde afuera (adentro del visor no hay devtools) hay un panel de
consola en la esquina inferior derecha, y `window.__bench` expone el renderer,
el rig, la config y el logger.
