import * as THREE from 'three'
import { ACTIONS, ACTION_MAP, EMOTIONS } from './actions.js'

const TAU = Math.PI * 2
const JOINT_NAMES = [
  'Hips', 'Chest', 'Neck', 'Head', 'Antenna',
  'Shoulder_L', 'Shoulder_R', 'Elbow_L', 'Elbow_R', 'Hand_L', 'Hand_R', 'Thumb_L', 'Thumb_R',
  'Hip_L', 'Hip_R', 'Knee_L', 'Knee_R', 'Foot_L', 'Foot_R',
]
const FACE_NAMES = [
  'Eye_L', 'Eye_R', 'Eye_Glint_L', 'Eye_Glint_R', 'Brow_L', 'Brow_R', 'Blush_L', 'Blush_R',
  'StarEye_L', 'StarEye_R', 'HeartEye_L', 'HeartEye_R', 'DizzyEye_L', 'DizzyEye_R',
  'Mouth_Smile', 'Mouth_Sad', 'Mouth_Open', 'Mouth_Tongue', 'Mouth_Surprised', 'Mouth_Sleep',
]
const ACTION_EMOTIONS = {
  greet: 'happy', wave: 'happy', nod: 'happy', bow: 'happy', clap: 'happy', cheer: 'excited',
  jump: 'excited', dance: 'happy', spin: 'happy', robotDance: 'happy', walkInPlace: 'happy',
  workout: 'excited', celebrate: 'excited', peekaboo: 'surprised', blowKiss: 'love', hug: 'love',
  highFive: 'happy', thumbsUp: 'happy', magic: 'excited', thinking: 'thinking', listening: 'happy',
  speaking: 'happy', confused: 'confused', surprised: 'surprised', laugh: 'happy', shy: 'love',
  sad: 'sad', angry: 'angry', sleepy: 'sleepy', sleep: 'sleepy', wakeUp: 'surprised',
  scared: 'surprised', dizzy: 'dizzy', sneeze: 'surprised',
}
const clamp = THREE.MathUtils.clamp
const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t) }
const envelope = (p) => Math.sin(Math.PI * clamp(p, 0, 1))
const track = (p, frames) => {
  if (p <= frames[0][0]) return frames[0][1]
  for (let i = 1; i < frames.length; i++) {
    const b = frames[i], a = frames[i - 1]
    if (p <= b[0]) return a[1] + (b[1] - a[1]) * smooth((p - a[0]) / (b[0] - a[0]))
  }
  return frames[frames.length - 1][1]
}

/**
 * Framework-independent procedural driver for the X.Du rigid-part GLB.
 * Add controller.object (not the raw model) to your scene, then call update(dt).
 */
export class RobotController {
  constructor(model, options = {}) {
    if (!model?.isObject3D) throw new TypeError('RobotController 需要一个 THREE.Object3D 模型')
    this.model = model
    this.object = new THREE.Group()
    this.object.name = 'XDu_Controller'
    this.object.add(model)
    this.settings = { speed: 1, amplitude: 1, headScale: 1, idle: true, ...options }
    this.nodes = {}
    this.face = {}
    this.rest = new Map()
    this.faceRest = new Map()
    this.events = new Map()
    this.queue = []
    this.time = 0
    this.actionTime = 0
    this.current = null
    this.emotion = 'neutral'
    this.lookTarget = null
    this.speechLevel = 0
    this.speechTarget = 0
    this.speechExternal = false
    this.frozen = false
    this.disposed = false
    this._blinkSeed = 7
    this._nextBlink = 2.2
    this._blinkStart = -1
    this._worldHead = new THREE.Vector3()
    this._worldTarget = new THREE.Vector3()
    this.eyeHalos = {}
    this.eyeHaloRest = {}
    model.traverse((node) => {
      if (JOINT_NAMES.includes(node.name)) {
        this.nodes[node.name] = node
        this.rest.set(node, { position: node.position.clone(), quaternion: node.quaternion.clone(), scale: node.scale.clone() })
      }
      if (FACE_NAMES.includes(node.name)) {
        this.face[node.name] = node
        this.faceRest.set(node, {
          position: node.position.clone(), quaternion: node.quaternion.clone(), scale: node.scale.clone(),
        })
      }
    })
    for (const required of ['Head', 'Shoulder_L', 'Shoulder_R', 'Elbow_L', 'Elbow_R']) {
      if (!this.nodes[required]) throw new Error(`X.Du 模型缺少关节：${required}`)
    }
    // Place the halo in head space, in front of the curved visor. Attaching it
    // to the eye mesh's local axis put it inside the face on the exported GLB.
    const glowSize = 64
    const glowData = new Uint8Array(glowSize * glowSize * 4)
    for (let y = 0; y < glowSize; y++) {
      for (let x = 0; x < glowSize; x++) {
        const nx = (x + .5) / glowSize * 2 - 1
        const ny = (y + .5) / glowSize * 2 - 1
        const alpha = Math.pow(Math.max(0, 1 - Math.hypot(nx, ny)), 2.0)
        const i = (y * glowSize + x) * 4
        glowData[i] = glowData[i + 1] = glowData[i + 2] = 255
        glowData[i + 3] = Math.round(alpha * 220)
      }
    }
    this.eyeGlowTexture = new THREE.DataTexture(glowData, glowSize, glowSize, THREE.RGBAFormat)
    this.eyeGlowTexture.needsUpdate = true
    this.object.updateWorldMatrix(true, true)
    const objectQuaternion = this.object.getWorldQuaternion(new THREE.Quaternion())
    const headInverse = this.nodes.Head.getWorldQuaternion(new THREE.Quaternion()).invert()
    const haloForward = new THREE.Vector3(0, 0, .040).applyQuaternion(objectQuaternion).applyQuaternion(headInverse)
    for (const side of ['L', 'R']) {
      const eye = this.face['Eye_' + side]
      if (!eye) continue
      const material = new THREE.SpriteMaterial({
        map: this.eyeGlowTexture, color: '#35F2C3', transparent: true, opacity: .94,
        blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true, toneMapped: false,
      })
      const halo = new THREE.Sprite(material)
      halo.name = 'Eye_Halo_' + side
      // The exported face meshes keep their origins at the head pivot. Use the
      // visible geometry centre, not the object origin, to align each halo.
      const eyePosition = new THREE.Box3().setFromObject(eye).getCenter(new THREE.Vector3())
      halo.position.copy(this.nodes.Head.worldToLocal(eyePosition)).add(haloForward)
      halo.scale.set(.26, .34, 1)
      halo.renderOrder = 4
      this.nodes.Head.add(halo)
      this.eyeHalos[side] = halo
      this.eyeHaloRest[side] = halo.position.clone()
    }
    this._createMagicWand()
    this._setFace('neutral', 0)
    this.play('idle')
  }

  _createMagicWand() {
    // The prop belongs to the portable driver, not the demo stage. Hand_R's
    // local +Y follows the mitten, so the wand remains firmly gripped by IK.
    const hand = this.nodes.Hand_R
    const group = new THREE.Group()
    group.name = 'Magic_Wand'
    group.position.set(0, .035, .018)
    group.rotation.z = .26
    group.visible = false
    const metal = new THREE.MeshStandardMaterial({ color: '#DDE8E8', metalness: .88, roughness: .22 })
    metal.name = '小杜 · 魔法棒钛金属'
    const gripMaterial = new THREE.MeshStandardMaterial({ color: '#18272D', metalness: .72, roughness: .30 })
    gripMaterial.name = '小杜 · 魔法棒握柄'
    const glowMaterial = new THREE.MeshStandardMaterial({
      color: '#A8FFE7', emissive: '#43FFD1', emissiveIntensity: 2.4,
      metalness: .12, roughness: .22, toneMapped: false,
    })
    glowMaterial.name = '小杜 · 魔法星芒'
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(.011, .014, .205, 20), metal)
    handle.position.y = .125
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(.018, .018, .072, 20), gripMaterial)
    grip.position.y = .047
    const collar = new THREE.Mesh(new THREE.TorusGeometry(.024, .005, 8, 32), glowMaterial)
    collar.rotation.x = Math.PI / 2
    collar.position.y = .224
    const shape = new THREE.Shape()
    for (let i = 0; i < 10; i++) {
      const angle = Math.PI / 2 + i * Math.PI / 5
      const radius = i % 2 ? .034 : .076
      const x = Math.cos(angle) * radius, y = Math.sin(angle) * radius
      if (i === 0) shape.moveTo(x, y)
      else shape.lineTo(x, y)
    }
    shape.closePath()
    const star = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, {
      depth: .016, bevelEnabled: true, bevelSize: .004, bevelThickness: .004, bevelSegments: 2,
    }), glowMaterial)
    star.name = 'Magic_Wand_Star'
    star.position.set(0, .305, -.008)
    const ring = new THREE.Mesh(new THREE.TorusGeometry(.103, .005, 8, 48), glowMaterial)
    ring.name = 'Magic_Wand_Halo'
    ring.position.set(0, .305, .004)
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.eyeGlowTexture, color: '#70FFDD', transparent: true, opacity: .82,
      blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true, toneMapped: false,
    }))
    halo.name = 'Magic_Wand_Glow'
    halo.position.set(0, .305, .015)
    halo.scale.set(.32, .32, 1)
    const tip = new THREE.Object3D()
    tip.name = 'Magic_Wand_Tip'
    tip.position.set(0, .305, .025)
    const light = new THREE.PointLight('#66FFD8', 0, 2.4, 2)
    light.name = 'Magic_Wand_Light'
    tip.add(light)
    group.add(handle, grip, collar, star, ring, halo, tip)
    hand?.add(group)
    this.magic = { group, tip, star, ring, halo, light, glowMaterial, active: false, strength: 0, burst: 0, phase: 0 }
  }

  _resetMagic() {
    if (!this.magic) return
    this.magic.active = false
    this.magic.strength = 0
    this.magic.burst = 0
    this.magic.phase = 0
    this.magic.group.visible = false
    this.magic.light.intensity = 0
    this.magic.halo.material.opacity = 0
  }

  getMagicTip(target = new THREE.Vector3()) {
    this.object.updateWorldMatrix(true, true)
    return this.magic.tip.getWorldPosition(target)
  }

  getMagicState() {
    const { active, strength, burst, phase } = this.magic
    return { active, strength, burst, phase }
  }

  static get actions() { return ACTIONS }
  listActions() { return ACTIONS.map((action) => ({ ...action })) }

  on(type, callback) {
    if (!this.events.has(type)) this.events.set(type, new Set())
    this.events.get(type).add(callback)
    return () => this.off(type, callback)
  }

  off(type, callback) { this.events.get(type)?.delete(callback) }
  _emit(type, detail) {
    for (const callback of this.events.get(type) || []) callback({ type, ...detail })
  }

  play(name, options = {}) {
    const definition = ACTION_MAP.get(name)
    if (!definition) throw new RangeError(`未知动作“${name}”。可用动作：${ACTIONS.map((a) => a.name).join(', ')}`)
    if (this.disposed) return Promise.reject(new Error('RobotController 已销毁'))
    if (name === 'speaking' && !this.speechExternal) {
      this.speechTarget = 0
      this.speechLevel = 0
    } else if (name !== 'speaking') {
      this.speechExternal = false
    }
    if (this.current?.resolve) this.current.resolve({ action: this.current.definition.name, cancelled: true })
    const loop = options.loop ?? definition.loop ?? false
    this.actionTime = 0
    this.emotion = options.emotion || 'neutral'
    this.frozen = false
    this.current = { definition, loop, speed: options.speed ?? 1, resolve: null }
    this._emit('actionstart', { action: name, definition })
    const promise = new Promise((resolve) => { this.current.resolve = resolve })
    this._pose(this.time)
    return promise
  }

  enqueue(name, options = {}) {
    if (!ACTION_MAP.has(name)) return Promise.reject(new RangeError(`未知动作“${name}”`))
    return new Promise((resolve, reject) => {
      this.queue.push({ name, options, resolve, reject })
      this._emit('queuechange', { length: this.queue.length })
    })
  }

  stop() {
    this.queue.splice(0).forEach((item) => item.resolve({ action: item.name, cancelled: true }))
    return this.play('idle')
  }

  setEmotion(name) {
    if (!EMOTIONS.includes(name)) throw new RangeError(`未知表情“${name}”；可选：${EMOTIONS.join(', ')}`)
    this.emotion = name
    this._setFace(name, this.time)
  }

  setSpeaking(speaking, level = .65) {
    this.speechExternal = Boolean(speaking)
    this.speechTarget = speaking ? clamp(level, 0, 1) : 0
    if (speaking && this.current?.definition.name !== 'speaking') this.play('speaking')
    if (!speaking && this.current?.definition.name === 'speaking') this.play('idle')
  }

  setSpeechLevel(level) {
    this.speechExternal = true
    this.speechTarget = clamp(level, 0, 1)
  }

  _speechAmount() {
    if (this.current?.definition.name === 'speaking' && !this.speechExternal) {
      // The action button has no audio analyser. Give it an explicit speech
      // performance instead of leaving the mouth at the external level zero.
      return .18 + .78 * (.5 + .5 * Math.sin(this.actionTime * TAU * 2.4))
    }
    return this.speechLevel
  }

  lookAt(target) {
    if (Array.isArray(target)) this.lookTarget = new THREE.Vector3().fromArray(target)
    else if (target?.isVector3) this.lookTarget = target.clone()
    else throw new TypeError('lookAt 接受 [x,y,z] 或 THREE.Vector3')
  }

  clearLookAt() { this.lookTarget = null }

  setFrozen(frozen) { this.frozen = Boolean(frozen) }

  sample(name, time = 0) {
    const definition = ACTION_MAP.get(name)
    if (!definition) throw new RangeError(`未知动作“${name}”`)
    this.current = { definition, loop: definition.loop ?? false, speed: 1, resolve: null }
    this.actionTime = Math.max(0, time)
    this.emotion = 'neutral'
    this.frozen = true
    this._pose(this.time)
    return this
  }

  update(dt) {
    if (this.disposed || this.frozen) return
    dt = Math.min(Math.max(dt, 0), .1)
    this.time += dt * this.settings.speed
    this.speechLevel = THREE.MathUtils.damp(this.speechLevel, this.speechTarget, 12, dt)
    const current = this.current
    if (current) {
      this.actionTime += dt * this.settings.speed * current.speed
      const duration = current.definition.duration
      if (current.loop && this.actionTime >= duration) {
        this.actionTime %= duration
        this._emit('actionloop', { action: current.definition.name })
      } else if (!current.loop && this.actionTime >= duration) {
        this._finishAction()
      }
    }
    this._pose(this.time)
  }

  _finishAction() {
    const finished = this.current
    const name = finished.definition.name
    finished.resolve?.({ action: name, cancelled: false })
    this._emit('actionend', { action: name })
    const next = this.queue.shift()
    if (next) {
      this.play(next.name, next.options).then(next.resolve, next.reject)
      this._emit('queuechange', { length: this.queue.length })
    } else {
      this.play('idle')
    }
  }

  getState() {
    return {
      action: this.current?.definition.name || 'idle',
      actionTime: this.actionTime,
      duration: this.current?.definition.duration || 0,
      loop: Boolean(this.current?.loop),
      emotion: this.emotion || ACTION_EMOTIONS[this.current?.definition.name] || 'neutral',
      speaking: this.current?.definition.name === 'speaking',
      speechLevel: this.speechLevel,
      queued: this.queue.length,
      frozen: this.frozen,
    }
  }

  _rot(name, x = 0, y = 0, z = 0, weighted = true) {
    const node = this.nodes[name]
    if (!node) return
    const a = weighted ? this.settings.amplitude : 1
    node.rotation.x += x * a
    node.rotation.y += y * a
    node.rotation.z += z * a
  }

  _aimModel(node, child, direction) {
    // Convert a model-space direction through the actual parent transform. This
    // remains correct when the whole robot turns during celebrate or dance.
    this.object.updateWorldMatrix(true, true)
    const restDirection = child.position.clone().applyQuaternion(this.rest.get(node).quaternion).normalize()
    const objectQuaternion = this.object.getWorldQuaternion(new THREE.Quaternion())
    const parentInverse = node.parent.getWorldQuaternion(new THREE.Quaternion()).invert()
    const targetDirection = direction.clone().normalize().applyQuaternion(objectQuaternion).applyQuaternion(parentInverse)
    node.quaternion.setFromUnitVectors(restDirection, targetDirection)
    this.object.updateWorldMatrix(true, true)
  }

  _arm(side, upperDirection, lowerDirection, weight = 1) {
    const shoulder = this.nodes['Shoulder_' + side]
    const elbow = this.nodes['Elbow_' + side]
    const hand = this.nodes['Hand_' + side]
    if (!shoulder || !elbow || !hand) return
    const blend = (child, restNode, target) => {
      const restDirection = child.position.clone().applyQuaternion(this.rest.get(restNode).quaternion).normalize()
      return restDirection.lerp(new THREE.Vector3().fromArray(target).normalize(), clamp(weight * this.settings.amplitude, 0, 1)).normalize()
    }
    this._aimModel(shoulder, elbow, blend(elbow, shoulder, upperDirection))
    this._aimModel(elbow, hand, blend(hand, elbow, lowerDirection))
  }

  _armTarget(side, target, elbowHint, weight = 1) {
    // Analytic two-bone IK: the hand follows a known safe/contact position and
    // the elbow stays in a chosen outward plane instead of folding into the head.
    const shoulder = this.nodes['Shoulder_' + side]
    const elbow = this.nodes['Elbow_' + side]
    const hand = this.nodes['Hand_' + side]
    if (!shoulder || !elbow || !hand) return
    this.object.updateWorldMatrix(true, true)
    const point = (node) => {
      const p = node.getWorldPosition(new THREE.Vector3())
      return this.object.worldToLocal(p)
    }
    const shoulderPoint = point(shoulder)
    const upperLength = shoulderPoint.distanceTo(point(elbow))
    const lowerLength = point(elbow).distanceTo(point(hand))
    const desired = point(hand).lerp(new THREE.Vector3().fromArray(target), clamp(weight * this.settings.amplitude, 0, 1))
    const offset = desired.clone().sub(shoulderPoint)
    const distance = clamp(offset.length(), Math.abs(upperLength - lowerLength) + .002, upperLength + lowerLength - .002)
    const direction = offset.normalize()
    const reachable = shoulderPoint.clone().addScaledVector(direction, distance)
    const bend = new THREE.Vector3().fromArray(elbowHint)
    bend.addScaledVector(direction, -bend.dot(direction))
    if (bend.lengthSq() < .0001) bend.set(side === 'L' ? 1 : -1, 0, 0)
    bend.normalize()
    const along = (upperLength ** 2 - lowerLength ** 2 + distance ** 2) / (2 * distance)
    const out = Math.sqrt(Math.max(0, upperLength ** 2 - along ** 2))
    const elbowPoint = shoulderPoint.clone().addScaledVector(direction, along).addScaledVector(bend, out)
    this._aimModel(shoulder, elbow, elbowPoint.clone().sub(shoulderPoint))
    this._aimModel(elbow, hand, reachable.sub(elbowPoint))
  }

  _clapHand(side) {
    // Local +Y is the mitten's long axis and local +Z is its palm normal.
    // Keep the hands upright and turn the palms towards one another.
    const hand = this.nodes['Hand_' + side]
    if (!hand) return
    const sign = side === 'L' ? 1 : -1
    const basis = new THREE.Matrix4().makeBasis(
      new THREE.Vector3(0, 0, sign),
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(-sign, 0, 0),
    )
    const desiredModel = new THREE.Quaternion().setFromRotationMatrix(basis)
    const objectQuaternion = this.object.getWorldQuaternion(new THREE.Quaternion())
    const parentInverse = hand.parent.getWorldQuaternion(new THREE.Quaternion()).invert()
    hand.quaternion.copy(parentInverse.multiply(objectQuaternion.multiply(desiredModel)))
    this.object.updateWorldMatrix(true, true)
  }

  _thumbsUpHand(weight) {
    // Keep the wrist attached while presenting the palm forward and the fist
    // upright. Only orientation changes; the Hand joint position is untouched.
    const hand = this.nodes.Hand_R
    if (!hand) return
    this.object.updateWorldMatrix(true, true)
    const objectQuaternion = this.object.getWorldQuaternion(new THREE.Quaternion())
    const parentInverse = hand.parent.getWorldQuaternion(new THREE.Quaternion()).invert()
    const desiredParent = parentInverse.multiply(objectQuaternion)
    hand.quaternion.slerp(desiredParent, clamp(weight * this.settings.amplitude, 0, 1))
    this.object.updateWorldMatrix(true, true)
  }

  _pose(time) {
    for (const [node, rest] of this.rest) {
      node.position.copy(rest.position)
      node.quaternion.copy(rest.quaternion)
      node.scale.copy(rest.scale)
    }
    this.nodes.Head.scale.multiplyScalar(this.settings.headScale)
    this.object.position.set(0, 0, 0)
    this.object.rotation.set(0, 0, 0)
    this.object.scale.set(1, 1, 1)
    const idle = this.settings.idle ? 1 : 0
    const breath = Math.sin(time * TAU / 4)
    this.object.position.y = idle * .008 * breath
    this.object.scale.y = 1 + idle * .008 * breath
    this.object.scale.x = this.object.scale.z = 1 - idle * .003 * breath
    this._rot('Chest', 0, 0, idle * .018 * Math.sin(time * 1.3))
    this._rot('Head', idle * .012 * Math.sin(time * 1.8), idle * .045 * Math.sin(time * .55), idle * .018 * Math.sin(time * .8))
    this._rot('Antenna', idle * .04 * Math.sin(time * 2.1 - .6), 0, idle * .055 * Math.sin(time * 1.7 - .8))
    this._resetMagic()

    const action = this.current?.definition
    if (action) this._applyAction(action.name, this.actionTime, action.duration)
    this._applyGaze()
    const expression = this.emotion !== 'neutral' ? this.emotion : ACTION_EMOTIONS[action?.name] || 'neutral'
    this._setFace(expression, time)
  }

  _applyAction(name, t, duration) {
    const p = clamp(t / duration, 0, 1)
    const e = envelope(p)
    const s = (hz = 1) => Math.sin(t * TAU * hz)
    const breath = Math.sin(t * TAU / 4)
    switch (name) {
      case 'idle': break
      case 'greet':
        this._rot('Chest', .12 * e, 0, -.08 * e)
        this._armTarget('L', [.43 + .035 * s(1.7),1.01,.26], [1,-.10,.45], e)
        this._rot('Head', -.08 * e, .12 * e, -.12 * e)
        break
      case 'wave':
        this._armTarget('L', [.43 + .035 * s(1.8),1.01,.26], [1,-.10,.45])
        this._rot('Head', 0, .1, -.12)
        break
      case 'nod':
        this._rot('Head', .26 * s(2) * e)
        this._rot('Chest', .07 * e)
        break
      case 'shakeHead':
        this._rot('Head', -.025 * e, .24 * s(1.25) * e, 0)
        this._rot('Shoulder_L', 0, 0, .18 * e)
        this._rot('Shoulder_R', 0, 0, -.18 * e)
        break
      case 'bow': {
        const bow = track(p, [[0,0],[.18,0],[.38,1],[.68,1],[1,0]])
        this._rot('Hips', .68 * bow)
        this._rot('Head', -.16 * bow)
        this._rot('Shoulder_L', -.35 * bow, 0, .12 * bow)
        this._rot('Shoulder_R', -.35 * bow, 0, -.12 * bow)
        break
      }
      case 'clap': {
        const contact = .5 + .5 * Math.cos(t * TAU * 2.2)
        const spread = .300 - .238 * contact
        for (const side of ['L', 'R']) {
          const sign = side === 'L' ? 1 : -1
          this._armTarget(side, [sign * spread,.79,.335], [sign,-.35,-.05])
          this._clapHand(side)
        }
        this._rot('Head', 0, 0, .06 * s(1.1))
        break
      }
      case 'cheer':
        this.object.position.y += Math.abs(s(2)) * .07
        this._armTarget('L', [.44,.98,.25 + .02 * s(1.5)], [1,.10,.50])
        this._armTarget('R', [-.44,.98,.25 - .02 * s(1.5)], [-1,.10,.50])
        this._rot('Head', -.12, 0, .08 * s(1))
        break
      case 'jump': {
        const height = track(p, [[0,0],[.18,-.07],[.30,0],[.52,.30],[.68,0],[.80,-.045],[1,0]])
        this.object.position.y += height
        const squash = track(p, [[0,1],[.18,.90],[.30,1.04],[.52,1.02],[.68,1],[.8,.91],[1,1]])
        this.object.scale.y *= squash
        this.object.scale.x = this.object.scale.z *= 1 + (1 - squash) * .45
        this._rot('Hip_L', -.35 * e)
        this._rot('Hip_R', -.35 * e)
        this._rot('Knee_L', .55 * e)
        this._rot('Knee_R', .55 * e)
        this._rot('Shoulder_L', 0, 0, 1.2 * e)
        this._rot('Shoulder_R', 0, 0, -1.2 * e)
        break
      }
      case 'dance':
        this.object.position.x = .12 * s(.5)
        this.object.position.y += Math.abs(s(1)) * .045
        this.object.rotation.y = .18 * s(.5)
        this._rot('Chest', 0, 0, .18 * s(1))
        this._rot('Head', 0, 0, -.14 * s(1))
        this._rot('Shoulder_L', -.3 * s(1), 0, 1.0 + .55 * s(1))
        this._rot('Shoulder_R', .3 * s(1), 0, -1.0 + .55 * s(1))
        this._rot('Hip_L', .32 * s(1))
        this._rot('Hip_R', -.32 * s(1))
        break
      case 'spin':
        this.object.rotation.y = TAU * smooth(p)
        this._rot('Shoulder_L', 0, 0, 1.55 * e)
        this._rot('Shoulder_R', 0, 0, -1.55 * e)
        this._rot('Head', 0, 0, .1 * Math.sin(p * Math.PI * 4))
        break
      case 'robotDance': {
        const beat = Math.round(s(1) * 3) / 3
        this._rot('Chest', 0, .18 * beat, .12 * beat)
        this._rot('Head', 0, -.3 * beat, 0)
        this._rot('Shoulder_L', -.6 * beat, 0, 1.25)
        this._rot('Shoulder_R', .6 * beat, 0, -1.25)
        this._rot('Elbow_L', 0, 0, .75 * beat)
        this._rot('Elbow_R', 0, 0, .75 * beat)
        this.object.position.y += .025 * Math.abs(beat)
        break
      }
      case 'peekaboo': {
        // Shrink the body into the head silhouette and hide to the left. The
        // inverse Head scale keeps the face readable instead of shrinking it.
        const hide = track(p, [[0,0],[.22,1],[.68,1],[.92,0],[1,0]])
        const bodyScale = 1 - .94 * hide
        this.nodes.Hips.scale.multiplyScalar(bodyScale)
        this.nodes.Head.scale.multiplyScalar(1 / bodyScale)
        this.object.position.x -= .62 * hide
        this.object.position.y += .48 * (1 - bodyScale)
        this.object.position.z -= .10 * hide
        this._rot('Head', -.06 * hide, -.30 * hide, -.14 * hide)
        break
      }
      case 'blowKiss': {
        const toMouth = track(p, [[0,0],[.28,1],[.48,1],[.78,0],[1,0]])
        const send = track(p, [[0,0],[.42,0],[.65,1],[.85,0],[1,0]])
        this._arm('L', [.45 + .25 * send,.10 + .30 * send,.85], [-.55 + send,.75 - .35 * send,.40 + .35 * send], Math.max(toMouth, send))
        this._rot('Head', 0, 0, -.12 * e)
        this.object.position.z = .06 * send
        break
      }
      case 'hug':
        this._arm('L', [.60,-.10,.80], [-.85,-.05,.55], e)
        this._arm('R', [-.60,-.10,.80], [.85,-.05,.55], e)
        this._rot('Head', .12 * e, 0, .1 * Math.sin(p * Math.PI * 2))
        break
      case 'highFive':
        this._arm('R', [-.30,.65,.70], [-.15,.90,.35], e)
        this._rot('Hand_R', 0, 0, -.2 * e)
        this._rot('Head', -.08 * e, -.12 * e)
        break
      case 'thumbsUp': {
        this._armTarget('R', [-.43,.82,.34], [-1,-.30,.45], e)
        this._thumbsUpHand(e)
        const thumb = this.nodes.Thumb_R
        if (thumb) {
          thumb.position.y += .075 * e
          thumb.position.z += .010 * e
          thumb.scale.multiplyScalar(1 + .20 * e)
        }
        this._rot('Head', .10 * Math.sin(p * Math.PI * 4) * e, -.08 * e, -.05 * e)
        break
      }
      case 'thinking':
        this._arm('R', [-.45,-.10,.85], [.45,.85,.30])
        this._rot('Head', -.12, .15, .18 + .025 * s(.4))
        this._rot('Shoulder_L', 0, 0, .12)
        break
      case 'listening':
        this._rot('Chest', .16, 0, -.08)
        this._rot('Head', -.08, -.18, -.22)
        this._arm('L', [.55,.35,.55], [-.25,.90,.30])
        break
      case 'speaking': {
        const talk = .25 + this._speechAmount()
        this._armTarget('L', [.34 + .025 * s(1.3),.67 + .025 * talk,.25], [1,-.35,.30])
        this._armTarget('R', [-.34 - .025 * s(1.1),.67 - .025 * talk,.25], [-1,-.35,.30])
        this._rot('Head', 0, .06 * s(.7), .05 * s(1.2))
        break
      }
      case 'confused':
        this._rot('Head', 0, -.16, .3 * e)
        this._rot('Shoulder_L', -.25 * e, 0, .95 * e)
        this._rot('Shoulder_R', -.25 * e, 0, -.95 * e)
        this._rot('Elbow_L', -.5 * e, 0, -.35 * e)
        this._rot('Elbow_R', -.5 * e, 0, .35 * e)
        break
      case 'surprised':
        this.object.position.z = -.10 * e
        this.object.position.y += .04 * e
        this._rot('Chest', -.18 * e)
        this._rot('Head', -.18 * e)
        this._rot('Shoulder_L', -.3 * e, 0, 1.1 * e)
        this._rot('Shoulder_R', -.3 * e, 0, -1.1 * e)
        break
      case 'laugh':
        this.object.position.y += Math.abs(s(3)) * .025
        this._rot('Chest', -.18 + .05 * s(3))
        this._rot('Head', -.2 + .06 * s(3), 0, .06 * s(1.5))
        this._rot('Shoulder_L', -.85, 0, -.38)
        this._rot('Shoulder_R', -.85, 0, .38)
        this._rot('Elbow_L', -.65)
        this._rot('Elbow_R', -.65)
        break
      case 'shy':
        this.object.rotation.y = .12 * s(.7)
        this._rot('Head', .28, .18, .14)
        this._arm('L', [.35,-.25,.90], [-.65,.15,.75])
        this._arm('R', [-.35,-.25,.90], [.65,.15,.75])
        break
      case 'sad':
        this.object.position.y -= .035
        this._rot('Chest', .16)
        this._rot('Head', .38, 0, .08 * s(.3))
        this._rot('Shoulder_L', .12, 0, -.08)
        this._rot('Shoulder_R', .12, 0, .08)
        break
      case 'angry':
        this.object.position.y += Math.abs(Math.sin(p * Math.PI * 4)) * .035 * e
        this._rot('Head', .12, 0, .06 * s(2))
        this._rot('Shoulder_L', -.2, 0, .72)
        this._rot('Shoulder_R', -.2, 0, -.72)
        this._rot('Elbow_L', 0, 0, -1.1)
        this._rot('Elbow_R', 0, 0, 1.1)
        this._rot('Foot_L', .3 * Math.max(0, s(2)) * e)
        this._rot('Foot_R', .3 * Math.max(0, -s(2)) * e)
        break
      case 'sleepy':
        this._rot('Head', .18, 0, .18 * s(.25))
        this._arm('L', [.45,-.20,.80], [-.20,.90,.40], e)
        this._rot('Chest', .08)
        break
      case 'sleep':
        this.object.position.y -= .055
        this.object.scale.y *= 1 + .015 * breath
        this._rot('Chest', .18)
        this._rot('Head', .42, .12, .18)
        this._arm('L', [.35,-.25,.90], [-.65,.15,.75])
        this._arm('R', [-.35,-.25,.90], [.65,.15,.75])
        break
      case 'wakeUp':
        this.object.position.y += .06 * e
        this._rot('Chest', -.15 * e)
        this._rot('Head', .35 * (1-smooth(p)) - .12 * e)
        this._arm('L', [.55,.85,.10], [.25,1,.15], e)
        this._arm('R', [-.55,.85,.10], [-.25,1,.15], e)
        break
      case 'scared':
        this.object.position.z = -.16 * e
        this.object.position.y -= .04 * e
        this._rot('Chest', -.2 * e)
        this._rot('Head', -.15 * e, .25 * s(2) * e)
        this._arm('L', [.50,.35,.75], [-.35,.85,.40], e)
        this._arm('R', [-.50,.35,.75], [.35,.85,.40], e)
        break
      case 'dizzy':
        this.object.rotation.y = .22 * s(.7)
        this.object.rotation.z = .08 * s(.7)
        this._rot('Head', 0, .18 * s(1.4), .3 * s(.7))
        this._rot('Shoulder_L', 0, 0, .5 + .25 * s(.7))
        this._rot('Shoulder_R', 0, 0, -.5 - .25 * s(.7))
        break
      case 'sneeze': {
        const anticipation = track(p, [[0,0],[.35,1],[.48,0],[1,0]])
        const sneeze = track(p, [[0,0],[.38,0],[.52,1],[.75,0],[1,0]])
        this._rot('Chest', -.28 * anticipation + .62 * sneeze)
        this._rot('Head', -.3 * anticipation + .48 * sneeze)
        this._rot('Shoulder_L', -.7 * anticipation - .3 * sneeze, 0, .5 * e)
        this._rot('Shoulder_R', -.7 * anticipation - .3 * sneeze, 0, -.5 * e)
        this.object.position.z = .1 * sneeze
        break
      }
      case 'walkInPlace':
        this.object.position.y += Math.abs(s(1)) * .035
        this._rot('Hip_L', .45 * s(1))
        this._rot('Hip_R', -.45 * s(1))
        this._rot('Knee_L', .45 * Math.max(0, -s(1)))
        this._rot('Knee_R', .45 * Math.max(0, s(1)))
        this._rot('Shoulder_L', -.4 * s(1))
        this._rot('Shoulder_R', .4 * s(1))
        break
      case 'workout': {
        const open = Math.abs(s(1))
        this.object.position.y += open * .08
        this._armTarget('L', [.34 + .12 * open,.76 + .24 * open,.18 + .08 * open], [1,-.30,.30])
        this._armTarget('R', [-.34 - .12 * open,.76 + .24 * open,.18 + .08 * open], [-1,-.30,.30])
        this._rot('Hip_L', 0, 0, .18 * open)
        this._rot('Hip_R', 0, 0, -.18 * open)
        this._rot('Head', 0, 0, .06 * s(2))
        break
      }
      case 'celebrate':
        this.object.position.y += Math.abs(s(1.5)) * .10 * e
        this.object.rotation.y = .35 * s(.75)
        this._armTarget('L', [.44,.98,.25 + .02 * s(2)], [1,.10,.50])
        this._armTarget('R', [-.44,.98,.25 - .02 * s(2)], [-1,.10,.50])
        this._rot('Head', -.15, 0, .12 * s(1.5))
        break
      case 'magic': {
        const appear = smooth((p - .035) / .10)
        const disappear = 1 - smooth((p - .88) / .10)
        const cast = appear * disappear
        const lift = track(p, [[0,0],[.16,.30],[.32,.72],[.56,1],[.74,.88],[1,0]])
        const wave = Math.sin((p - .12) * TAU * 2.25)
        const sweep = Math.cos((p - .10) * TAU * 1.55)
        this._armTarget('R', [-.45 - .085 * wave,.67 + .30 * lift,.31 + .035 * sweep], [-1,-.25,.45], cast)
        this._armTarget('L', [.37 + .025 * wave,.64 + .06 * lift,.25], [1,-.35,.35], cast)
        this._thumbsUpHand(cast)
        this._rot('Head', -.10 * cast, -.08 * wave * cast, .08 * wave * cast)
        this._rot('Antenna', .10 * s(1.5) * cast, t * TAU * cast, .12 * s(1.2) * cast)
        const burst = smooth((p - .575) / .045) * (1 - smooth((p - .70) / .16))
        const strength = cast * (.72 + .20 * Math.sin(t * TAU * 2.1) + .32 * burst)
        const m = this.magic
        m.active = cast > .01
        m.phase = p
        m.strength = Math.max(0, strength)
        m.burst = burst
        m.group.visible = m.active
        m.group.scale.setScalar(Math.max(.001, cast))
        m.glowMaterial.emissiveIntensity = 2.4 + 4.8 * burst + .6 * Math.sin(t * TAU * 3)
        m.light.intensity = m.strength * (1.2 + 5.5 * burst)
        m.halo.material.opacity = cast * (.62 + .32 * burst)
        m.halo.scale.setScalar(.28 + .16 * burst)
        m.ring.rotation.z = t * 1.8
        m.star.rotation.z = -t * 1.2
        break
      }
    }
  }

  _applyGaze() {
    if (!this.lookTarget || !this.nodes.Head) return
    this.object.updateWorldMatrix(true, true)
    this.nodes.Head.getWorldPosition(this._worldHead)
    this._worldTarget.copy(this.lookTarget)
    const dx = this._worldTarget.x - this._worldHead.x
    const dy = this._worldTarget.y - this._worldHead.y
    const dz = this._worldTarget.z - this._worldHead.z
    const yaw = clamp(Math.atan2(dx, dz), -.55, .55)
    const pitch = clamp(-Math.atan2(dy, Math.hypot(dx, dz)), -.3, .3)
    this._rot('Head', pitch, yaw, 0, false)
  }

  _blink(time) {
    if (this._blinkStart < 0 && time >= this._nextBlink) {
      this._blinkStart = time
      this._blinkSeed = (this._blinkSeed * 1664525 + 1013904223) >>> 0
      this._nextBlink = time + 2 + (this._blinkSeed / 4294967296) * 3
    }
    if (this._blinkStart < 0) return 0
    const p = (time - this._blinkStart) / .16
    if (p >= 1) { this._blinkStart = -1; return 0 }
    return Math.sin(p * Math.PI)
  }

  _setFace(expression, time) {
    const f = this.face
    // Facial nodes are animated from their rest transforms every frame. The old
    // incremental brow rotation accumulated indefinitely during continuous play.
    for (const [node, rest] of this.faceRest) {
      node.position.copy(rest.position)
      node.quaternion.copy(rest.quaternion)
      node.scale.copy(rest.scale)
    }
    const special = expression === 'excited' ? 'StarEye' : expression === 'love' ? 'HeartEye' : expression === 'dizzy' ? 'DizzyEye' : null
    for (const side of ['L', 'R']) {
      const normal = f['Eye_' + side]
      if (normal) normal.visible = !special
      if (this.eyeHalos[side]) this.eyeHalos[side].visible = !special
      const glint = f['Eye_Glint_' + side]
      if (glint) glint.visible = !special && expression !== 'sleepy'
      for (const kind of ['StarEye', 'HeartEye', 'DizzyEye']) {
        if (f[kind + '_' + side]) f[kind + '_' + side].visible = special === kind
      }
    }
    let eyeY = 1 - .94 * this._blink(time)
    let gazeX = 0, gazeY = 0
    if (expression === 'surprised' || expression === 'excited') eyeY = 1.18
    if (expression === 'sleepy') eyeY = .18
    if (expression === 'sad') eyeY = .72
    if (expression === 'angry') eyeY = .66
    if (expression === 'thinking') {
      eyeY = .84
      gazeX = .018 + .006 * Math.sin(this.actionTime * 1.1)
      gazeY = .020
    }
    if (expression === 'confused') {
      gazeX = .024 * Math.sin(this.actionTime * 2.4)
      gazeY = .006
    }
    for (const side of ['L', 'R']) {
      const sideEyeY = expression === 'confused' && side === 'L' ? Math.max(.12, eyeY * .68) : eyeY
      const eye = f['Eye_' + side]
      const glint = f['Eye_Glint_' + side]
      if (eye) {
        eye.scale.y = Math.max(.06, sideEyeY)
        eye.position.x += gazeX
        eye.position.y += gazeY
      }
      if (glint) {
        glint.scale.y = Math.max(.06, sideEyeY)
        glint.position.x += gazeX
        glint.position.y += gazeY
      }
      const halo = this.eyeHalos[side]
      if (halo) {
        halo.position.copy(this.eyeHaloRest[side])
        halo.position.x += gazeX
        halo.position.y += gazeY
        halo.scale.set(.26, .34 * Math.max(.06, sideEyeY), 1)
        halo.material.opacity = .94 * clamp(sideEyeY, .15, 1)
      }
      if (f['Blush_' + side]) {
        f['Blush_' + side].visible = expression === 'love'
        f['Blush_' + side].scale.setScalar(1.2)
      }
    }
    if (f.Brow_L && f.Brow_R) {
      const showBrows = ['angry', 'sad', 'surprised', 'thinking', 'confused'].includes(expression)
      f.Brow_L.visible = f.Brow_R.visible = showBrows
      let left = 0, right = 0, lift = 1
      if (expression === 'angry') { left = -.28; right = .28; lift = .75 }
      if (expression === 'sad') { left = .25; right = -.25; lift = .9 }
      if (expression === 'surprised') lift = 1.35
      if (expression === 'thinking') { left = .12; right = -.12 }
      if (expression === 'confused') { left = .22; right = -.05 }
      f.Brow_L.rotation.z += left
      f.Brow_R.rotation.z += right
      f.Brow_L.scale.y = f.Brow_R.scale.y = lift
    }
    const mouthLevel = this._speechAmount()
    const speakingOpen = this.current?.definition.name === 'speaking' && mouthLevel > .04
    const open = speakingOpen || ['surprised', 'laugh', 'sleepy', 'sneeze'].includes(this.current?.definition.name)
    const surprised = this.current?.definition.name === 'scared'
    const sleeping = this.current?.definition.name === 'sleep'
    const sad = expression === 'sad' || expression === 'angry' || expression === 'confused'
    const smiling = ['happy', 'laugh', 'excited', 'love'].includes(expression)
    if (f.Mouth_Smile) f.Mouth_Smile.visible = smiling && !open && !surprised && !sleeping && !sad
    if (f.Mouth_Sad) f.Mouth_Sad.visible = sad && !open
    if (f.Mouth_Open) {
      f.Mouth_Open.visible = open
      f.Mouth_Open.scale.y = speakingOpen ? .18 + mouthLevel * 1.50 : 1
      f.Mouth_Open.scale.x = speakingOpen ? .65 + mouthLevel * .45 : 1
    }
    if (f.Mouth_Tongue) {
      f.Mouth_Tongue.visible = open
      f.Mouth_Tongue.scale.y = speakingOpen ? .18 + mouthLevel * 1.50 : 1
      f.Mouth_Tongue.scale.x = speakingOpen ? .65 + mouthLevel * .45 : 1
    }
    if (f.Mouth_Surprised) f.Mouth_Surprised.visible = surprised
    if (f.Mouth_Sleep) f.Mouth_Sleep.visible = sleeping
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.current?.resolve?.({ action: this.current.definition.name, cancelled: true })
    this.queue.splice(0).forEach((item) => item.resolve({ action: item.name, cancelled: true }))
    this.events.clear()
    for (const halo of Object.values(this.eyeHalos)) {
      halo.removeFromParent()
      halo.material.dispose()
    }
    const disposedMaterials = new Set()
    this.magic?.group.traverse((node) => {
      node.geometry?.dispose()
      for (const material of node.material ? [].concat(node.material) : []) {
        if (!disposedMaterials.has(material)) { material.dispose(); disposedMaterials.add(material) }
      }
    })
    this.magic?.group.removeFromParent()
    this.eyeGlowTexture?.dispose()
    this.object.remove(this.model)
  }
}
