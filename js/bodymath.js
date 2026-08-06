// Geometry for turning marked landmarks into body circumferences.
//
// A torso cross-section is closer to an ellipse than a circle, so a front view
// alone cannot give a circumference — it gives the width. Pairing it with the
// side view supplies the depth, and the two axes define the ellipse.
//
// Ramanujan's approximation is used for the perimeter; it is accurate to far
// better than a millimetre over the width:depth ratios human torsos occupy,
// which is well inside the error of the landmark marking itself.

export function ellipseCircumference(width, depth) {
  const a = width / 2;
  const b = depth / 2;
  return Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
}

// When the side view is skipped, depth is inferred from width. These ratios
// are mid-range adult torso proportions; they are a guess, and any measurement
// built on them is reported at lower confidence.
export const ASSUMED_DEPTH_RATIO = { chest: 0.72, waist: 0.78 };

// Pixels-per-cm from the marked head-top and floor points against known height.
export function scaleFrom(headPoint, floorPoint, heightCm) {
  const px = Math.abs(floorPoint.y - headPoint.y);
  if (!px || !heightCm) return null;
  return px / heightCm;
}

export function pxDistance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Convert a marked pair of points to centimetres at a given scale.
export function spanCm(a, b, pxPerCm) {
  return pxDistance(a, b) / pxPerCm;
}

// Body circumference (cm) for one landmark level.
export function circumferenceAt(level, frontWidthCm, sideDepthCm) {
  const depth = sideDepthCm ?? frontWidthCm * ASSUMED_DEPTH_RATIO[level];
  return {
    circumference: ellipseCircumference(frontWidthCm, depth),
    depth,
    estimatedDepth: sideDepthCm == null,
  };
}

// Derive the flat half-width of a garment that would fit this body the way the
// user says they like it. Garment circumference = body + ease; flat = half.
export function derivedFlat(bodyCircumference, garmentEase, preferenceEase) {
  return (bodyCircumference + garmentEase + preferenceEase) / 2;
}
