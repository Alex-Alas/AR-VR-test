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
  IPD, FOV, k1, k2 y aberración cromática son ajustables en vivo.
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

1. Settings → Pages → Source: *Deploy from a branch* → rama `claude/vr-ar-mvp-testing-5qrbr5`, carpeta `/`.
2. Abrir la URL que queda publicada, desde Chrome en Android.

**Opción local**

```bash
npx http-server -p 8080          # en la computadora
# el teléfono por USB, con depuración activada:
adb reverse tcp:8080 tcp:8080    # y abrir http://localhost:8080 en el teléfono
```

`localhost` cuenta como contexto seguro, así que funciona todo sin certificado.

## Orden recomendado la primera vez

1. **⚙️ Calibración**, con el teléfono en la mano:
   - Medí con una regla el **alto físico** del área visible de la pantalla y
     cargalo. Sin ese dato, los grados del modo pantalla son inventados y las
     dos columnas de resultados no se pueden comparar.
   - Poné tu **IPD** (o probá hasta que las dos imágenes fusionen sin esfuerzo).
2. **👁️ Ver patrón de ajuste** con el teléfono ya en el visor: subí `k1` hasta
   que las líneas rectas se vean rectas, y `chroma` hasta que se vayan las
   franjas de color de los bordes.
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
- **La agudeza usa 2 ensayos por tamaño** con criterio "todo correcto, cortando
  en la primera falla". Es una escalera corta: rápida, no clínica.
- **iOS no corre esto.** Safari no tiene WebXR y `DeviceOrientationEvent`
  necesita permiso explícito. Está pensado para Chrome en Android.

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
