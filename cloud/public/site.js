// Install tabs, opened on the visitor's OS; the download button for it goes first.
const tabs = [...document.querySelectorAll("[role=tab]")];
function show(id) {
	for (const t of tabs) {
		const on = t.getAttribute("aria-controls") === id;
		t.setAttribute("aria-selected", on);
		document.getElementById(t.getAttribute("aria-controls")).hidden = !on;
	}
}
for (const t of tabs) t.addEventListener("click", () => show(t.getAttribute("aria-controls")));
// The hero's download buttons lead to the install guide, on their OS's tab.
for (const b of document.querySelectorAll(".cta .btn[data-os]")) b.addEventListener("click", () => show(b.dataset.os));
// Screenshot marquee: one copy of the slides at least as wide as the screen, then that copy twice. The offset is
// kept within one copy, so the strip never runs out whichever way it goes. Hover stops it, a drag moves it (and
// throws it on release), and with reduced motion it only moves when dragged.
const marquee = document.querySelector(".marquee");
const track = marquee.querySelector(".track");
const originals = [...track.children];
const SPEED = 40; // px a second
const still = matchMedia("(prefers-reduced-motion: reduce)");
let half = 0, x = 0, velocity = 0, hovering = false, drag = null, last = performance.now();
function fill() {
	for (const c of [...track.children].slice(originals.length)) c.remove();
	const gap = parseFloat(getComputedStyle(track).columnGap) || 0;
	const unit = originals.reduce((w, s) => w + s.getBoundingClientRect().width + gap, 0);
	const copies = Math.max(1, Math.ceil(innerWidth / unit));
	for (let i = 1; i < copies * 2; i++) {
		for (const s of originals) {
			const c = s.cloneNode(true);
			c.setAttribute("aria-hidden", "true");
			track.append(c);
		}
	}
	half = unit * copies;
}
function place() {
	x = ((x % half) - half) % half; // within (-half, 0]
	track.style.transform = `translateX(${x}px)`;
}
function frame(now) {
	const dt = Math.min(now - last, 100) / 1000;
	last = now;
	if (!drag) {
		// A throw decays back to the drift (or to rest with reduced motion).
		const target = hovering || still.matches ? 0 : -SPEED;
		velocity += (target - velocity) * Math.min(1, dt * 3);
		x += velocity * dt;
		place();
	}
	requestAnimationFrame(frame);
}
fill();
place();
requestAnimationFrame(frame);
let width = innerWidth;
addEventListener("resize", () => { if (innerWidth !== width) { width = innerWidth; fill(); place(); } });

marquee.addEventListener("pointerenter", (e) => { if (e.pointerType === "mouse") hovering = true; });
marquee.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") hovering = false; });
marquee.addEventListener("pointerdown", (e) => {
	if (e.button !== 0) return;
	drag = { id: e.pointerId, x: e.clientX, t: e.timeStamp, v: 0 };
	velocity = 0;
	marquee.setPointerCapture(e.pointerId);
	marquee.classList.add("held");
});
marquee.addEventListener("pointermove", (e) => {
	if (!drag || e.pointerId !== drag.id) return;
	const dx = e.clientX - drag.x, dt = Math.max(e.timeStamp - drag.t, 1) / 1000;
	drag.v = drag.v * 0.6 + (dx / dt) * 0.4;
	drag.x = e.clientX;
	drag.t = e.timeStamp;
	x += dx;
	place();
});
function release(e) {
	if (!drag || e.pointerId !== drag.id) return;
	// A pointer held still before letting go throws nothing.
	velocity = e.timeStamp - drag.t > 80 ? 0 : Math.max(-3000, Math.min(3000, drag.v));
	drag = null;
	marquee.classList.remove("held");
}
marquee.addEventListener("pointerup", release);
marquee.addEventListener("pointercancel", release);
marquee.addEventListener("contextmenu", (e) => e.preventDefault());
marquee.addEventListener("dragstart", (e) => e.preventDefault());

for (const b of document.querySelectorAll(".copy")) {
	b.addEventListener("click", async () => {
		try {
			await navigator.clipboard.writeText(b.closest(".cmd").querySelector("code").textContent);
			b.textContent = "Copied";
		} catch {
			b.textContent = "Select and copy";
		}
		setTimeout(() => { b.textContent = "Copy"; }, 1500);
	});
}
if (/Windows/.test(navigator.userAgent)) {
	show("win");
	const win = document.querySelector(".btn[data-os=win]");
	document.querySelector(".btn[data-os=mac]").classList.remove("primary");
	win.classList.add("primary");
	win.parentElement.prepend(win);
}
