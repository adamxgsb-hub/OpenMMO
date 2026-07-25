# Making art that matches OpenMMO

Derived from Jake's own documented workflow (`doc/assets/characters.md`,
`doc/assets/items.md`, `doc/ANIMATION.md`) plus a look at what his shipped
assets actually are. Follow this and your contributions should be
indistinguishable in style from his.

## The house style, in one line

**Photoreal 3D product shots** — soft studio lighting, slight 3/4 angle,
desaturated leather-and-steel palette, neutral background. Not stylised, not
flat, not cel-shaded.

His `leather_armor` is the reference: a 1179×1334 photoreal render on plain
grey (`doc/images/leather_armor.png`) that became **both** the Meshy input
**and**, downscaled, the 128×128 inventory icon. Icon and mesh share one
source image — that's why everything sits together.

## Before anything: Git LFS

`*.glb`, `*.blend`, `*.mp3` are LFS-tracked. Without LFS you get 134-byte
pointers instead of models.

```bash
git lfs install
git lfs pull
head -c 12 assets/all_animation.blend    # BLENDER-v### → install that major version
```

---

## Item pipeline (rod, and re-doing the fish/flotsam icons)

### 1. Concept image

Generate a **single object, centred, on a flat neutral grey background, soft
studio key light from upper-left, gentle contact shadow, slight 3/4 view,
photorealistic materials, no text, no border**. Square-ish, ≥1024 px.

Prompt that matches his look, for the rod:

> Photorealistic product render of a medieval wooden fishing rod on a flat
> neutral grey studio background. Slender tapered hazel shaft with visible
> wood grain, wrapped leather grip with brass ferrule, waxed horsehair line
> looped along the shaft, small bone hook. Weathered, hand-made, functional —
> not ornate. Soft studio key light from upper left, gentle contact shadow,
> slight three-quarter angle, muted earthy palette of browns and aged brass.
> Centred, full object in frame, no text.

Keep the full-resolution image — it goes in `doc/images/fishing_rod.png` and
gets referenced from `doc/assets/items.md`, exactly as he does.

### 2. Meshy (Image to 3D)

On a **paid plan** — free-tier output is CC BY 4.0 and carries an attribution
obligation you don't want in his repo. Paid generations keep full commercial
rights permanently, including after you downgrade.

- Use **Image to 3D** with the concept above.
- Ask for **PBR textures**; keep the mesh modest — a rod needs far less than a
  character. A few thousand triangles is plenty (he remeshes *characters* to
  ~10k).
- **Do not publish to the Meshy Community feed.**
- **Keep the invoice** — he records paid-tier provenance for every generated
  asset.

### 3. Blender cleanup

The rod must drop into the same hand socket the placeholder uses, so match the
placeholder rather than guessing:

1. Import `client/public/models/weapons/spear.glb` — this is what
   `fishing_rod` currently points at, so its **scale, origin and axis
   orientation are your target**.
2. Import the Meshy `.glb`, then scale/rotate/translate it until it overlays
   the spear's grip position and length. Put the origin where the hand grips.
3. Delete the spear.
4. Check materials (Shader Editor — he specifically breaks stray Alpha links,
   which otherwise render as invisible patches).
5. Export `.glb` → `client/public/models/weapons/fishing_rod.glb`.

### 4. Wire it up

- `data-src/items.csv`: change the `fishing_rod` row's `worldModel` from
  `weapons/spear.glb` to `weapons/fishing_rod.glb`.
- `client/public/items/fishing_rod.png`: 128×128, transparent, downscaled from
  the concept render.
- `doc/assets/items.md`: add a line in his format, e.g.
  `fishing_rod.glb — Meshy.ai (유료 생성, YYYY-MM-DD, "<generation name>"). 완전 소유권·상업 OK`
  plus `원화는 <tool>` linking `doc/images/fishing_rod.png`.

### 5. Turning a render into an icon

`make-icon.py` in this repo does the conversion — background knock-out, trim,
diagonal rotation for long subjects (his sword icons sit diagonally so they
fill the square), and a transparent 128x128 output:

```bash
pip install pillow numpy
python make-icon.py trout_render.png raw_trout.png
```

It knocks the background out with a region-growing flood fill from the image
border rather than a colour key, so grey *inside* the subject survives — which
matters for a silver fish on a grey backdrop — and a graded backdrop is
followed all the way in. Flags: `--tol` (raise if a halo survives, lower if it
eats into the subject) and `--no-rotate` to keep a wide subject horizontal.

Verified against Jake's own material: running it on his
`doc/images/leather_armor.png` concept render reproduces something
indistinguishable from the `leather_armor.png` icon he shipped.

### 6. Redo the 2D icons

Same concept-image treatment for the five fish and four flotsam items, then
downscale to 128×128 with transparency. The current ones are hand-drawn flat
vector and visibly don't belong — replacing them is the single biggest
style win available.

---

## Animation pipeline (fishing cast / idle)

Full rules in `doc/ANIMATION.md`; production steps in `doc/assets/animation.md`.

1. **Mixamo** → FBX **Binary**, **Without Skin**, **30 FPS**, **Keyframe
   Reduction: none**. Tick **In Place** for anything that travels.
2. **Blender** — import through his retargeting script, which handles the
   A-pose→T-pose bake:
   ```python
   import sys; sys.path.insert(0, r"<repo>\tools\blender-scripts")
   from import_mixamo_animation import import_mixamo_animation
   import_mixamo_animation(fbx_path=r"...\Fishing Cast.fbx", action_name="fishing_cast")
   ```
3. Add the action name to `EXPORT_PACKS` in
   `tools/blender-scripts/export_animations.py`. Packs today: `locomotion`,
   `combat_melee`, `social`, `offhand`.
4. Export:
   ```bash
   blender assets/all_animation.blend --background --python tools/blender-scripts/export_animations.py
   ```
   (strips the `mixamorig:` prefix automatically)
5. Client wiring: add to `AnimationName`, **keep `AnimationIndex` in sync**
   (it's an ordered array — a desync silently plays the wrong clip), extend
   `selectOrderedCharacterAnimations`, then `PlayerModel.svelte` and
   `CharacterPreview.svelte`.
6. `cd client && npm run lint && npm run check`

### The three traps his docs call out

- **A-pose vs T-pose** — Mixamo rests in A-pose, the project armature is
  T-pose. Skip the retarget bake and your character stands like a scarecrow.
- **`Armature.001`** — FBX import always binds to a new armature; the retarget
  step is what rebinds the action to `Armature`.
- **Centimetres** — Mixamo's Hips location is cm-scaled; used raw the
  character flies kilometres away. The import script deliberately doesn't bake
  location channels, which is why only in-place clips are supported.

## Where fishing animations hook in

The client already tracks fishing state in `stores/fishingStore.ts`
(`myFishingPhase`: idle / casting / bite / struggle). `PlayerModel.svelte`
picks clips from play state today; a cast one-shot on `casting` and a looping
`fishing_idle` while waiting is the minimal wiring. No server change needed —
this is client-side presentation only.

---

## The prompt pack

Nine of the ten assets are **icons only** — `worldModel` is empty for every
fish and flotsam item, so they never render in the world. Only the rod needs
a mesh. That means nine image generations and one 3D job, not ten.

House style, in every prompt: *photorealistic product render, single object,
centred, flat neutral grey studio background, soft key light from upper left,
gentle contact shadow, slight three-quarter angle, muted earthy palette, no
text, no watermark, no border.* Square, 1024px or better.

Reject and regenerate if the image has: a busy or coloured background, more
than one object, text/labels, the object cropped at the frame edge, or a
silhouette that turns to mush when you squint (it has to read at 32px).

### Fish

- **Raw Minnow** — a tiny silver freshwater minnow, side profile, barely a
  handspan, plain silver flanks with a faint dark lateral stripe, wet sheen.
- **Raw Perch** — a European river perch, side profile, olive-green back with
  bold dark vertical bars, orange-red lower fins, spiny dorsal raised.
- **Raw Trout** — a speckled brown trout, side profile, buttery-olive flank
  with dark and red spots, soft adipose fin, freshly caught wet sheen.
- **River Salmon** — a powerful silver salmon, side profile, steel-blue back
  fading to bright silver flanks, small dark spots above the lateral line,
  strong forked tail.
- **Golden Sturgeon** — an armoured ancient river sturgeon, side profile,
  long tapering body with a pointed rostrum and barbels beneath the snout,
  rows of raised bony scutes along the back and flank, upturned shark-like
  tail, aged-brass gold rather than bright yellow.

### Flotsam

- **Old Boot** — a single waterlogged medieval leather boot, sodden and
  misshapen, broken lace, a strand of weed caught on the heel, water dripping.
- **Clump of Kelp** — a tangled clump of olive-green kelp fronds gathered in a
  loose knot, a few air bladders, slick and dripping.
- **Message in a Bottle** — a corked green glass bottle lying at a slight
  tilt, a rolled parchment scrap visible inside, twine wrapped at the neck,
  weathered.
- **Sunken Coin Pouch** — a drowned leather drawstring purse, dark waterlogged
  cloth slumped open, a few tarnished copper coins spilling out, weed draped
  across it.

### The rod (also needs a mesh)

> Photorealistic product render of a medieval wooden fishing rod on a flat
> neutral grey studio background. Slender tapered hazel shaft with visible
> wood grain, wrapped leather grip with a brass ferrule, waxed line looped
> along the shaft, small bone hook. Weathered, hand-made, functional — not
> ornate. Soft studio key light from upper left, gentle contact shadow,
> slight three-quarter angle, muted browns and aged brass. Centred, full
> object in frame, no text.

**Expect the rod to be the hard one.** Long thin geometry is the weakest case
for image-to-3D: the shaft may come out lumpy and the line usually vanishes
entirely. Two ways through:

1. **Try Meshy first** (cheap). If the shaft is clean and only the line is
   missing, that's fine — the line was never going to survive, and the
   placeholder spear has no line either.
2. **If it comes out lumpy, model it by hand.** A rod is a tapered cylinder
   plus a grip — genuinely 20 minutes in Blender for a first-timer: add a
   cylinder, scale one end down, add a short fatter cylinder for the grip,
   two brown materials, done. It will look *better* than a bad generation and
   costs nothing.

Either way, finish in Blender against `spear.glb` as the transform reference
(see the item pipeline above).
