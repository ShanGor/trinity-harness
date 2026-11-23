# Trinity Soft Glass — visual strategy and implementation

Date: 2026-11-23  
Status: Implemented locally; authenticated deployment and real-device acceptance remain separate gates. Supersedes the earlier neutral/opaque revision, which did not deliver the requested visible depth.

## 1. Why the earlier UI did not feel like iOS

The first implementation added blur to an existing desktop layout. The second removed most of the effect: an opaque sidebar/header, flat neutral canvas and a 92%-opaque composer made the change nearly invisible. The login screen retained its original card. CSS support and passing interaction tests did not prove the intended appearance.

| Dimension   | Previous Trinity                                     | iOS reference principle                              | Trinity decision                                                                                                 |
| ----------- | ---------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Layering    | Attached rectangular regions with similar lightness  | Controls occupy a distinct layer above content       | Luminous backdrop → quiet reading plane → frosted navigation → elevated composer and sheets                      |
| Material    | Near-white blur over an almost uniform background    | Material responds to its surroundings                | Blue, lavender and mint light fields provide visible context; white glass preserves text clarity                 |
| Geometry    | Small control corners mixed with large input corners | Rounded geometry relates to its container            | 12px compact controls, 20px toolbar/cards, 26–28px navigation/composer, 36px login; capsules for grouped actions |
| Navigation  | Text-only rows and several boxed header actions      | Related controls are grouped and visually consistent | Uniform line icons, rounded selected rows and grouped capsule actions; compact header expansion retained         |
| Typography  | Similar emphasis across labels and headings          | Scale and weight establish hierarchy                 | Confident welcome heading, quieter support text and compact metadata; system typography                          |
| Login       | Ordinary opaque form card                            | Entry surfaces share the product's material language | Centered frosted card, luminous background, dimensional logo, inset fields and a raised primary action           |
| Interaction | Mostly default component feedback                    | Controls feel responsive and cohesive                | Brief press feedback, explicit focus, consistent hover and reduced-motion support                                |

Apple describes Liquid Glass controls as a separate functional layer above content, with rounded geometry and grouped controls, and describes material color as influenced by surrounding content. These principles inform our hierarchy and geometry. [Apple design introduction](https://www.apple.com/newsroom/2025/06/apple-introduces-a-delightful-and-elegant-new-software-design/), [Apple Materials guidance](https://developer.apple.com/design/human-interface-guidelines/materials).

Trinity implements a CSS interpretation. Native optical refraction, hardware-aware corner rendering and system-adaptive vibrancy are not delivered by CSS blur. Our acceptance target is a visibly layered, coherent interface, rather than optical equivalence.

## 2. Visual direction: Soft Glass

The mood is calm, luminous and precise. Green remains the action accent. A cool blue/lavender/mint backdrop is stronger on Login and visible at the workspace perimeter; the central reading plane attenuates it. No animated wallpaper, raster texture or external font is required.

Material roles:

- **Backdrop:** static broad radial light fields, shared across login and workspace.
- **Reading plane:** a quiet, mostly white central workspace; text/code do not receive backdrop filters.
- **Navigation glass:** 58% light fill, 28px blur and 145% saturation, bounded to sidebar/header. A white edge and inset top highlight establish material thickness.
- **Control glass:** 72% white, matching blur, with a softer lifted shadow for composer/login/voice sheets. The composer has one external surface; Sender's inner border and shadow remain removed.
- **Content and forms:** readable text, light inset fields and near-opaque settings surfaces. Approval/terminal states keep semantic colors and direct visibility.

These are implemented starting values, not measured universal contrast guarantees. Stronger transparency must not wash out text or obscure focus/selection.

## 3. Geometry and component specifications

- The desktop sidebar is an inset 26px-radius glass panel; the workspace is a separate 28px-radius reading plane. The toolbar is inset within it. Desktop margins are 12px.
- Mobile keeps an edge-to-edge reading plane, inset glass header and overlay navigation. The closed sidebar takes no horizontal space. Targets remain at least 44px.
- The composer is a 28px-radius elevated surface, capped at 780px, with full-width text and an aligned lower attachment/voice/model row. Active-task controls retain their additional rows. Textarea identity, Pretext measurement and drafts remain intact.
- Login uses a 460px maximum card, 36px radius, 44px desktop padding, 72px logo, 52px fields/button and a capsule primary action. Mobile reduces padding to 24px and radius to 30px.
- Compact controls use 12px corners. Segmented controls and toolbar actions use capsules. Modal content uses 28px corners. Do not apply glass to every message/card.
- Heading scale distinguishes welcome content from transcript body and metadata. Use system UI fonts, including native Apple fonts on Apple platforms; do not distribute SF assets or fetch a web font.
- Shadows define elevation: restrained for navigation, larger/softer for login/composer and strongest for modal sheets. White edges complement the shadow; they do not replace keyboard focus.

## 4. Implementation ownership

`index.css` supplies base layout/text semantics; `main.tsx` aligns Ant Design colors and 12/20px control radii. `glass-materials.css` loads last and owns material roles and scoped geometry. `App.tsx` supplies navigation line icons and login composition while retaining login submission, ACP controls and session behavior.

Capability fallback starts with solid glass tokens. Supported browsers enable translucency and bounded filters. Reduced-transparency, increased-contrast and forced-color preferences restore solid fills, stronger borders and remove filters/shadows. Reduced motion disables new press transitions. No theme feature switch or backend change is introduced.

## 5. Review and release gates

- Inspect Login and Main on desktop and mobile, both empty and populated, plus expanded header actions and sidebar states. Judge the actual screenshots, not the presence of blur in computed styles.
- At 360/390/768/1280/1440px: no page overflow, clipped controls or model/voice collisions. Preserve drafts/focus and history identity through navigation/resizing/streaming.
- Check login validation, submission and password visibility; keep input semantics and credentials handling intact.
- Check normal, hover, pressed, disabled, selected and keyboard-focus states; inspect settings, approvals, attachments and voice mode before claiming complete visual acceptance.
- Measure composited text/control contrast against representative backdrops. Verify solid fallbacks and accessibility preferences. Real-phone keyboard/safe-area checks and Safari rendering are independent of Chromium emulation.
- Run frontend regressions, lint, typecheck and production build. Record actual results and deployment evidence in progress/checklist documents. This implementation task does not itself establish production deployment acceptance.
