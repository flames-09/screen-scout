const STYLE = `
  :root { color-scheme: dark; }
  body { margin: 0; font: 15px/1.6 system-ui, -apple-system, Segoe UI, sans-serif; background: #0f1216; color: #dbe2ea; }
  main { max-width: 720px; margin: 0 auto; padding: 48px 24px 64px; }
  h1 { font-size: 24px; letter-spacing: -0.01em; }
  h2 { font-size: 16px; margin-top: 32px; }
  p, li { color: #b6c2cf; }
  code { background: #1a2028; padding: 1px 5px; border-radius: 4px; font-size: 13px; }
  a { color: #7cc4ff; }
  footer { margin-top: 48px; color: #6d7b8a; font-size: 13px; }
`

function page(title: string, body: string): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
     <meta name="viewport" content="width=device-width,initial-scale=1">
     <title>${title} â€” Screen Scout relay</title><style>${STYLE}</style></head>
     <body><main>${body}<footer>Screen Scout relay Â· <a href="/privacy">Privacy</a> Â· <a href="/terms">Terms</a> Â· <a href="/guidelines">Guidelines</a></footer></main></body></html>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' } }
  )
}

export function landingPage(): Response {
  return page(
    'Screen Scout relay',
    `<h1>Screen Scout relay</h1>
     <p>This is the small forwarding service that lets Screen Scout work without every user
        bringing their own API key. It accepts one screenshot question at a time, enforces a
        free daily limit per device (or per account if you sign in), and streams the answer back.</p>
     <h2>What it does with your data</h2>
     <ul>
       <li>Questions that include a screenshot are forwarded to NVIDIA's hosted
           vision model and, when that is unavailable,
           Cloudflare Workers AI (Llama 4 Scout); text-only questions may be served
           by Groq.</li>
       <li>The relay does not store screenshots, questions, or answers.</li>
       <li>It stores only a random device id and daily usage counters. Google sign-in is
           optional: if you use it, the relay keeps only a keyed hash of your account id â€”
           never your email or the sign-in token itself.</li>
     </ul>
     <p>Full detail: <a href="/privacy">privacy</a>, <a href="/terms">terms</a>, and
        <a href="/guidelines">safety guidelines</a>.</p>`
  )
}

export function guidelinesPage(): Response {
  return page(
    'Guidelines',
    `<h1>Safety &amp; use guidelines</h1>
     <p>Screen Scout answers questions about screenshots using third-party AI models. Keep these
        guidelines in mind when using it.</p>
     <h2>Crisis and self-harm</h2>
     <p>Screen Scout is a screenshot helper. It is <strong>not</strong> a crisis service and cannot
        provide emergency help. If you are thinking about harming yourself or someone else, please
        reach out now â€” real people are available, for free, around the clock:</p>
     <ul>
       <li><strong>US &amp; Canada:</strong> call or text <strong>988</strong> (Suicide &amp; Crisis Lifeline).</li>
       <li><strong>UK &amp; Ireland:</strong> call <strong>116 123</strong> (Samaritans).</li>
       <li><strong>Elsewhere:</strong> find a local helpline at
           <a href="https://findahelpline.com" rel="noopener">findahelpline.com</a>.</li>
       <li>If you or someone else is in immediate danger, contact your <strong>local emergency
           number</strong> right away.</li>
     </ul>
     <p>The assistant is instructed to share these resources if a message suggests you may be in
        crisis, and to set the screenshot task aside when that happens. Nothing you send is used
        to profile you, and the relay stores no conversations.</p>
     <h2>Fair use</h2>
     <ul>
       <li>Respect the free-tier limits. Do not automate bulk use, script the relay, or share
           device tokens.</li>
       <li>Do not use the service to create content that is illegal, harassing, deceptive, or that
           harms others.</li>
       <li>Only send screenshots you have the right to share â€” they are forwarded to a model
           provider to generate an answer.</li>
       <li>Do not include other people's private data (passwords, ID documents, private messages,
           medical or financial records). Crop it out or cover it before sending.</li>
     </ul>
     <h2>Not a professional service</h2>
     <p>Answers come from third-party models and may be wrong or incomplete. Do not rely on
        Screen Scout for medical, legal, financial, or safety-critical decisions.</p>`
  )
}

export function privacyPage(): Response {
  return page(
    'Privacy',
    `<h1>Privacy</h1>
     <p>Screen Scout is designed so that nothing leaves your computer until you press <strong>Send</strong>.
        When you use the free hosted mode, this relay forwards your selected screenshot crop and your
        question to a model provider and streams the answer back.</p>
     <h2>What is processed</h2>
     <ul>
       <li><strong>Screenshot + question</strong> â€” forwarded to NVIDIA's hosted vision
           model and, when NVIDIA is unavailable, Cloudflare
           Workers AI (Llama 4 Scout). The relay does not write them to storage and
           does not log their contents.</li>
       <li><strong>Text-only questions</strong> â€” questions sent without a screenshot may
           be served by Groq instead.</li>
       <li><strong>Device id</strong> â€” a random identifier generated by the app. It is not tied to your
           name, email, or account, and is used only for rate limiting. The relay stores it together
           with your app version and operating-system family so it can gate broken app versions and
           answer update requests â€” nothing else.</li>
       <li><strong>Update checks</strong> â€” the app periodically asks this relay whether a new version
           exists. The request carries no user data; your IP address is processed by Cloudflare as
           part of serving any request but is not stored by the relay.</li>
       <li><strong>Counters</strong> â€” how many questions a device asked today and in the current
           5-hour window. Usage counters are deleted after at most 7 days; an idle device id is
           deleted after 30 days.</li>
       <li><strong>Optional Google sign-in</strong> â€” anonymous device mode is the default and needs
           no account. If you sign in with Google to get account limits (5 screenshots and 50
           text chats per day), the app sends Google's sign-in token, the relay verifies it with
           Google, and stores <strong>only a keyed hash</strong> of your account id â€” an HMAC-SHA256
           value with an <code>acct:</code> prefix. The relay does not store your email, your Google
           account id, or the sign-in token. The app shows your email locally (read from the token);
           it is never stored server-side. Signing in uses one IP-throttled registration per day.
           Account counters live in the same usage table as device counters and are pruned after
           at most 7 days.</li>
     </ul>
     <h2>What is not collected</h2>
     <p>No IP addresses stored beyond short-lived abuse throttling, no analytics, no advertising
        identifiers, and no conversation history. There are no accounts or email addresses on the
        relay â€” <strong>unless you choose to sign in with Google</strong>, and even then only the
        keyed hash described above is kept; your email and the sign-in token are never stored.</p>
     <h2>Providers</h2>
     <p>Cloudflare states that Workers AI does not use customer inputs to train models.
        Groq's services agreement prohibits using API inputs and outputs to train or
        fine-tune models, and Groq does not retain inference data by default.
        NVIDIA's developer terms for its hosted API permit NVIDIA to use submitted
        content to improve its products and services â€” so avoid sending confidential
        or sensitive material, or switch to <strong>My own NVIDIA key</strong> mode,
        where this relay is never contacted.</p>
     <h2>Deleting your data</h2>
      <p>The relay never writes screenshots, questions, or answers to storage - they are forwarded
         in memory only, so there is nothing stored to delete. What <em>is</em> stored (your device
         id, its usage counters, and, if you signed in, the keyed account hash) you can delete
         yourself: in the app, open <strong>Settings &gt; Access</strong> and use
         <strong>Delete my data on the relay</strong>. That immediately removes the device or account
         row and every counter tied to it from the database. If you signed in with Google, deleting
         does not touch your Google account; signing in again simply starts a fresh empty record.</p>
     <h2>Your choice</h2>
     <p>You can switch to <strong>My own NVIDIA key</strong> in Settings at any time. In that mode the app
        talks directly to the endpoint you configure and this relay is never contacted.</p>
     <p>Questions: open an issue on the project repository.</p>`
  )
}

export function termsPage(): Response {
  return page(
    'Terms',
    `<h1>Terms of use</h1>
     <p>This relay is a free, best-effort service provided so people can try Screen Scout without an
        API key. By using it you agree to the following.</p>
     <ul>
       <li><strong>Fair use.</strong> Limits are enforced per device (or per account if you sign in)
           and globally. Do not attempt to
           bypass them, automate bulk use, or share tokens.</li>
       <li><strong>No warranty.</strong> The service may be slow, unavailable, or discontinued at any
           time. Answers come from third-party models and may be wrong.</li>
       <li><strong>Acceptable use.</strong> Do not send content that is illegal, or that you do not have
           the right to share with a third-party model provider. See the full
           <a href="/guidelines">safety and use guidelines</a>.</li>
       <li><strong>Wellbeing.</strong> This service is not a crisis resource. If you are thinking about
           harming yourself, contact your local emergency number, call or text 988 (US/Canada), or
           find a local helpline at findahelpline.com. See the <a href="/guidelines">guidelines</a>.</li>
       <li><strong>Deletion.</strong> You can delete all stored data for your device or account at any
           time from the app (Settings â†’ Access â†’ Delete my data on the relay).</li>
       <li><strong>Privacy.</strong> See the <a href="/privacy">privacy notice</a>. The relay stores no
           screenshots or prompts.</li>
       <li><strong>Changes.</strong> Limits, providers, and these terms may change as the service
           evolves.</li>
     </ul>`
  )
}
