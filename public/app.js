/* Slotline's only client-side code: timezone detection and slot selection.
   Everything else is server-rendered forms, which keeps the booking flow
   working without JavaScript right up to the point of choosing a time. */

const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Pre-select the visitor's own zone on the signup form. */
for (const select of document.querySelectorAll('select[data-detect-timezone]')) {
  if ([...select.options].some((option) => option.value === detected)) select.value = detected;
  else if (detected) select.add(new Option(detected.replace('_', ' '), detected, true, true));
}

/* --------------------------------------------------------- booking page */

const tzSelect = document.getElementById('tz-select');
if (tzSelect) {
  const params = new URLSearchParams(window.location.search);
  // If the visitor has not chosen a zone, redirect once to their detected one
  // so the times on screen are theirs rather than the host's.
  if (!params.get('tz') && !document.cookie.includes('slotline_tz=') && detected) {
    if (![...tzSelect.options].some((option) => option.value === detected)) {
      tzSelect.add(new Option(detected.replace('_', ' '), detected));
    }
    if (tzSelect.value !== detected) {
      document.cookie = `slotline_tz=${encodeURIComponent(detected)};path=/;max-age=31536000;samesite=lax`;
      params.set('tz', detected);
      window.location.replace(`${window.location.pathname}?${params}`);
    }
  }

  tzSelect.addEventListener('change', () => {
    document.cookie = `slotline_tz=${encodeURIComponent(tzSelect.value)};path=/;max-age=31536000;samesite=lax`;
    const next = new URLSearchParams(window.location.search);
    next.set('tz', tzSelect.value);
    window.location.search = next.toString();
  });
}

const startsAtInput = document.getElementById('startsAt');
const chosen = document.getElementById('chosen');
const submit = document.getElementById('submit');

for (const button of document.querySelectorAll('.slot')) {
  button.addEventListener('click', () => {
    for (const other of document.querySelectorAll('.slot')) other.setAttribute('aria-pressed', 'false');
    button.setAttribute('aria-pressed', 'true');
    startsAtInput.value = button.dataset.iso;
    chosen.textContent = button.dataset.label;
    chosen.className = 'small';
    submit.disabled = false;
    if (window.innerWidth < 800) document.getElementById('inviteeName')?.focus();
  });
}

// Restore the highlight after a failed submit re-renders the page.
if (startsAtInput?.value) {
  const match = document.querySelector(`.slot[data-iso="${startsAtInput.value}"]`);
  if (match) {
    match.setAttribute('aria-pressed', 'true');
    chosen.textContent = match.dataset.label;
    chosen.className = 'small';
  } else if (chosen) {
    // The slot we had selected is gone — someone else took it.
    startsAtInput.value = '';
    chosen.textContent = 'Pick another time →';
    if (submit) submit.disabled = true;
  }
}
