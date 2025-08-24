const puppeteer = require("puppeteer");

async function loginOTL(browser, { kaistId }) {
  const page = await browser.newPage();
  page.setDefaultTimeout(200000);
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36"
  );
  await page.goto(
    "https://otl.kaist.ac.kr/session/login/?next=https://otl.kaist.ac.kr/",
    { waitUntil: "domcontentloaded" }
  );
  const ssoBtn = "#login-social-kaist-v2";
  if (await page.$(ssoBtn)) {
    await Promise.all([
      page
        .waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 })
        .catch(() => {}),
      page.click(ssoBtn),
    ]);
  }
  const idSel = "#login_id_mfa";
  await page.waitForSelector(idSel, { timeout: 30000 });
  await page.type(idSel, kaistId);
  await page.click("a.btn_login");
  const mfaOk = await page
    .waitForSelector(".nember_wrap", { timeout: 1000 })
    .then(() => true)
    .catch(() => false);
  if (!mfaOk) {
    await browser.close();
    throw new Error("[KAIST] 로그인 실패");
  }
  const code = await page.$$eval(".nember_wrap span", (spans) =>
    spans.map((s) => s.textContent.trim()).join("")
  );
  console.log("[KAIST] 인증번호:", code);
  const deviceBtnSel =
    'a[href="javascript:setDevice();"], a.btn_basic.btn_easy.mt20';
  await page.waitForSelector(deviceBtnSel, { timeout: 1000000 });
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 10000 }),
    page.click(deviceBtnSel),
  ]);
  try {
    await page.waitForFunction(
      () => location.href === "https://otl.kaist.ac.kr/",
      { timeout: 1000000 }
    );
  } catch {}
  return page;
}

async function fetchSessionInfo(page) {
  const url = "https://otl.kaist.ac.kr/session/info";
  const info = await page.evaluate(async (u) => {
    const res = await fetch(u, { credentials: "include" });
    if (!res.ok) throw new Error("session/info 실패: " + res.status);
    return res.json();
  }, url);
  return info;
}

function collectLecturesFromSessionInfo(info, { year, semester }) {
  const list = Array.isArray(info.my_timetable_lectures)
    ? info.my_timetable_lectures
    : [];
  return list.filter((l) => l.year === year && l.semester === semester);
}

async function fetchCurrentSemester(page) {
  const url = "https://otl.kaist.ac.kr/api/semesters?order=year&order=semester";
  const semesters = await page.evaluate(async (u) => {
    const res = await fetch(u, { credentials: "include" });
    if (!res.ok) throw new Error("Semesters fetch 실패: " + res.status);
    return res.json();
  }, url);
  if (!Array.isArray(semesters) || semesters.length === 0) {
    throw new Error("Semesters 데이터 비어있음");
  }
  const latest = semesters[semesters.length - 1];
  return latest;
}

function lectureToEverytimePayload(lecture) {
  const name = lecture.title || lecture.common_title || "Untitled";
  const professor = (lecture.professors || []).map((p) => p.name).join(", ");
  const cleanPlace = (p) => {
    if (!p || typeof p !== "string") return "";
    const idx = p.indexOf("호)");
    if (idx !== -1) return p.slice(0, idx + 2).trim();
    return p.trim();
  };
  const time_place = (lecture.classtimes || []).map((ct) => ({
    day: ct.day,
    starttime: Math.round(ct.begin / 5),
    endtime: Math.round(ct.end / 5),
    place: cleanPlace(ct.classroom || ct.classroom_short || ""),
  }));
  return { name, professor, time_place };
}

async function loginEverytime(browser, { everytimeId, everytimePw }) {
  const page = await browser.newPage();
  page.setDefaultTimeout(200000);
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36"
  );
  await page.goto("https://account.everytime.kr/login", {
    waitUntil: "domcontentloaded",
  });
  await page.waitForSelector('form input[name="id"]', { timeout: 15000 });
  await page.type('form input[name="id"]', everytimeId);
  await page.type('form input[name="password"]', everytimePw);
  const submitSel = 'form input[type="submit"]';
  await page.click(submitSel);
  await page
    .waitForFunction(() => location.href.startsWith("https://everytime.kr/"), {
      timeout: 5000,
    })
    .catch(() => {});
  if (!page.url().startsWith("https://everytime.kr/")) {
    await browser.close();
    throw new Error("[Everytime] 로그인 실패");
  }
  await page.goto("https://everytime.kr/timetable", {
    waitUntil: "domcontentloaded",
  });
  await new Promise((r) => setTimeout(r, 1000));
  return page;
}

async function readCredentials() {
  const rl = require("readline").createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const ask = (q) =>
    new Promise((res) => rl.question(q, (ans) => res(ans.trim())));
  const kaistId = await ask("KAIST ID 입력: ");
  const everytimeId = await ask("Everytime ID 입력: ");
  const everytimePw = await ask("Everytime PW 입력: ");
  rl.close();
  return { kaistId, everytimeId, everytimePw };
}

async function openCustomForm(page) {
  const formSel = "form#customsubjects";
  const buttonSel = "ul.floating li.button.custom";
  const visible = await page
    .$eval(formSel, (el) => window.getComputedStyle(el).display !== "none")
    .catch(() => false);
  if (visible) return;
  await page.click(buttonSel);
  await page.waitForSelector(formSel + ' input[name="name"]', {
    visible: true,
    timeout: 5000,
  });
}

function minutes5ToHourMin(idx) {
  const total = idx * 5;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return { h, m };
}

async function setSelectValue(page, root, selector, value) {
  await page.$eval(
    `${root} ${selector}`,
    (el, v) => {
      el.value = String(v);
      el.dispatchEvent(new Event("change", { bubbles: true }));
    },
    value
  );
}

async function setDay(page, timeplaceRoot, day) {
  await page.$$eval(
    `${timeplaceRoot} ol.weeks li`,
    (lis, d) => {
      lis.forEach((li, i) => {
        if (li.classList.contains("active")) li.classList.remove("active");
        if (i === d) li.classList.add("active");
      });
    },
    day
  );
}

async function addTimeSlotUI(page, index, slot) {
  const formSel = "form#customsubjects";
  if (index > 0) {
    const newBtn = await page.$(formSel + " .timeplaces a.new");
    if (newBtn) {
      await newBtn.click();
      await page.waitForFunction(
        (sel) => {
          const tp = document.querySelectorAll(sel + " .timeplace");
          return tp.length > 1;
        },
        {},
        formSel + " .timeplaces"
      );
    }
  }
  const tpIdx = await page.$$eval(
    formSel + " .timeplace",
    (list) => list.length - 1
  );
  const rootSelector = `${formSel} .timeplace:nth-of-type(${tpIdx + 1})`;
  await setDay(page, rootSelector, slot.day);
  const { h: sh, m: sm } = minutes5ToHourMin(slot.starttime);
  const { h: eh, m: em } = minutes5ToHourMin(slot.endtime);
  await setSelectValue(page, rootSelector, "select.starthour", sh);
  await setSelectValue(page, rootSelector, "select.startminute", sm);
  await setSelectValue(page, rootSelector, "select.endhour", eh);
  await setSelectValue(page, rootSelector, "select.endminute", em);
  if (slot.place) {
    await page.$eval(
      rootSelector + " input.place",
      (el, v) => {
        el.value = v;
        el.dispatchEvent(new Event("input", { bubbles: true }));
      },
      slot.place
    );
  }
}

async function addSubjectViaUI(page, payload) {
  await openCustomForm(page);
  const formSel = "form#customsubjects";
  await page.$eval(
    formSel + ' input[name="name"]',
    (el, v) => {
      el.value = v;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    },
    payload.name
  );
  await page.$eval(
    formSel + ' input[name="professor"]',
    (el, v) => {
      el.value = v;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    },
    payload.professor
  );
  const slots =
    payload.time_place && payload.time_place.length ? payload.time_place : [];
  if (slots.length === 0) {
    return false;
  }
  for (let i = 0; i < slots.length; i++) {
    await addTimeSlotUI(page, i, slots[i]);
  }
  await page.click(formSel + ' .submit input[type="submit"]');
  await new Promise((r) => setTimeout(r, 600));
  return true;
}

async function main() {
  const browser = await puppeteer.launch({
    headless: false,
  });

  try {
    const creds = await readCredentials();
    const otlPage = await loginOTL(browser, { kaistId: creds.kaistId });
    const latest = await fetchCurrentSemester(otlPage);
    const sessionInfo = await fetchSessionInfo(otlPage);
    const lectures = collectLecturesFromSessionInfo(sessionInfo, {
      year: latest.year,
      semester: latest.semester,
    });
    const payloads = lectures.map(lectureToEverytimePayload);

    const everytimePage = await loginEverytime(browser, {
      everytimeId: creds.everytimeId,
      everytimePw: creds.everytimePw,
    });
    try {
      const createBtn = await everytimePage.$("a.create");
      await createBtn.click();
      await new Promise((r) => setTimeout(r, 600));
    } catch {}

    for (const p of payloads) {
      console.log(`과목 추가: ${p.name}`);
      try {
        await addSubjectViaUI(everytimePage, p);
      } catch {}
    }
  } finally {
    await browser.close();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
