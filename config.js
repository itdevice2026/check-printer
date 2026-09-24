// Check Printer settings for this installation.
// The publishable key is safe to publish: every table is protected by row level security,
// and only people on the cp_allowed_users list can read or change records.
window.CP_CONFIG = {
  supabaseUrl: 'https://emkcwukiqxnvcbhkjiqz.supabase.co',
  supabaseKey: 'sb_publishable_u_qnmEI8oHI9Z_A0-Hht3Q_Yvaa7Ork',
  brand: {
    appTitle: 'Meatplus Check Printer',
    name: 'Check Printer',
    tagline: 'Meatplus group of companies',
    emailPlaceholder: 'name@meatplus.ph',
    usersHint: 'New people sign in with their existing company account for the Meatplus apps, or press Create account on the sign-in page.'
  }
};
