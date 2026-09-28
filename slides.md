---
theme: default
title: Deyslide
info: |
  ## Deyslide
  A hybrid presentation engine for live teaching and cinematic talks.
author: bambanggunawanid
colorSchema: dark
highlighter: shiki
lineNumbers: true
transition: slide-left
mdc: true
fonts:
  sans: Inter
  mono: JetBrains Mono
layout: cover
class: text-left
---

<div class="pointer-events-none absolute inset-0 opacity-60">
  <DeyslideScene3D
    scene-id="architecture"
    :camera-position="[9, 7, 12]"
    :spin="0.12"
    transparent
  />
</div>

<div class="relative z-10">

<span class="dey-chip">Live Teaching · Cinematic</span>

# <span class="dey-title">Deyslide</span>

A hybrid presentation engine for workshops, keynotes and video.

<div class="mt-8 flex gap-3 text-sm text-dey-muted">
  <span>Slidev</span><span>·</span><span>TresJS</span><span>·</span><span>Motion Canvas</span>
</div>

</div>

<!--
Welcome everyone. This deck runs in two modes:
live teaching, where we pause and explore, and cinematic mode for recordings.
The 3D scene behind the title is the same scene we zoom into on slide 3.
-->

---
layout: default
---

# Teaching: code that morphs

Three steps from a naive loop to a reusable helper.

````md magic-move {lines: true}
```ts
// Step 1: sum every price by hand
let total = 0
for (let i = 0; i < prices.length; i++) {
  total += prices[i]
}
```

```ts
// Step 2: let reduce do the loop
const total = prices.reduce((sum, price) => sum + price, 0)
```

```ts
// Step 3: name the idea and reuse it
export function sum(values: number[]): number {
  return values.reduce((acc, value) => acc + value, 0)
}

const total = sum(prices)
const tax = sum(taxes)
```
````

<!--
Step 1: ask the room what could go wrong with the index variable.
[click] Step 2: point out that reduce removes the mutable counter.
[click] Step 3: naming the helper lets us test it once and reuse it.
Pause here for questions before moving to the architecture slide.
-->

---
layout: two-cols
clicks: 3
---

# Spatial zoom

Each click moves the camera deeper into the system.

<v-clicks>

- **Gateway** routes every request
- **Orders Service** owns the business rules
- **Database** stores the source of truth

</v-clicks>

<div class="mt-6 text-xs text-dey-muted">
  Camera memory is shared with the title slide through <code>scene-id</code>,
  so the camera flies in from the title pose.
</div>

::right::

<div class="h-[420px]">
  <DeyslideScene3D
    scene-id="architecture"
    :camera-position="[8, 6, -7]"
    :focus="[undefined, 'gateway', 'orders', 'database'][$clicks]"
    :zoom-level="[1, 1.25, 1.45, 1.6][$clicks]"
  />
</div>

<!--
Start wide so everyone sees the whole system.
[click] Zoom on the gateway.
[click] Move to the orders service.
[click] End on the database, then take questions.
-->

---
layout: two-cols
---

# Algorithm animation

Bubble sort, one decision per frame.

- <span class="text-sky-400">Blue</span>: comparing two values
- <span class="text-pink-400">Pink</span>: swapping them
- <span class="text-emerald-400">Green</span>: value is in its final place

<div class="mt-6 text-xs text-dey-muted">
  Built with Motion Canvas from <code>animations/src/scenes/bubble-sort.tsx</code>.
  The same frames render in the browser and in the video export.
</div>

::right::

<DeyslideAlgoPlayer src="/animations/bubble-sort.js" />

<!--
Let the animation play once without talking.
Then restart it and pause on the first swap to explain why the larger value moves right.
-->

---
layout: default
---

# Live workshop Q&A

<DeyslideLiveSandbox
  title="Scene controls"
  :step="0.5"
  :initial="{ orbitControls: false, zoom: 1, showNotes: true, question: 'How does the cache stay fresh?' }"
>
  <template #default="{ state }">
    <div class="grid grid-cols-2 gap-3">
      <div class="h-[150px]">
        <DeyslideScene3D
          scene-id="qa"
          focus="cache"
          :orbit-controls="state.orbitControls"
          :zoom-level="state.zoom"
        />
      </div>
      <div class="text-sm">
        <div class="text-xs uppercase tracking-wider text-dey-muted">Current question</div>
        <div class="text-lg">{{ state.question }}</div>
        <div v-if="state.showNotes" class="mt-2 text-xs text-dey-muted">
          Tip: turn on orbitControls and drag the scene to answer spatial questions.
        </div>
      </div>
    </div>
  </template>
</DeyslideLiveSandbox>

<!--
Hand the clicker to a student if the room is small.
Turn on orbitControls to let them explore, then turn it off before recording.
-->
