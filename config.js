// config.js — where the shared order book lives.
//
// Both sites carry this same file. The key is NOT a secret: these pages are public, so anyone who
// reads the source can read it. It is a latch that keeps stray traffic out of the Sheet, nothing
// more. What keeps this safe is that the Sheet holds only invented demonstration orders — no guest
// names, no addresses, no payment. Never put a real customer's details through it.
//
// To point the sites at a different order book, change these two lines in both repositories.
const ORDERS = {
  endpoint: 'https://script.google.com/macros/s/AKfycbzwkWcJbT61dn4wX_tNtUucFpBbmNwLlc5UBvHo93bo7qKFI7KPc8UZ9X3N2ExyjMzdvw/exec',
  key: '1089c6dc345c4eadbae680b64c86032991df1170',
};
