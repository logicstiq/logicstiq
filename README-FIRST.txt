LOGICSTIQ — DEPLOY IN 2 STEPS
=============================

No software to install. No commands to type.

STEP 1
  Go to github.com and open your logicstiq repository.
  Click:  Add file  ->  Upload files
  Select EVERYTHING inside this folder and drag it into the browser window.
  Wait for the upload to finish.

STEP 2
  Scroll down, type a message like "site redesign", and click
  "Commit changes".

That's it. Vercel sees the change and deploys automatically, usually within
a minute or two. Your live site updates on its own.


A FEW THINGS TO KNOW
--------------------

Do not double-click the HTML files to preview them. They will look plain and
broken. That is normal and it is not a fault in the files. A website needs a
web server to load its styling, and your own computer isn't one. The pages
will look correct the moment they are live.

Nothing gets deleted. This folder contains every file your site already had,
plus 16 new ones. Overwriting is safe.

There is no build step. Every page in here is already finished. Nothing needs
to be compiled, generated or run.

If you want to see it before it goes live: on GitHub, create a new branch
during Step 2 instead of committing to main. Vercel will give you a private
preview link to check first.


WHAT CHANGED
------------

New pages
  tools.html            every tool, what it does, who it's for
  unit-economics.html   your real margin per SKU after RTO
  integrations.html     every channel, carrier and file format
  quick-commerce.html   Blinkit / Zepto / Instamart planning
  pricing.html          free, and why the sign-in exists
  vs-unicommerce.html   the comparison
  feedback.html         the review form, moved off the homepage

Rebuilt pages
  index.html, oms.html, wms.html, returns.html

Every other page kept its content and got the new navigation, the new
styling, and live calculators.

One legal change: terms.html now commits to LogicstIQ being free. Please
read that section before you commit. It is in point 3, "Accounts & saved
data", under "Pricing".

Calculators no longer have a Calculate button. Results appear as you type.


IF SOMETHING LOOKS WRONG AFTER IT GOES LIVE
-------------------------------------------
On GitHub, open the commit you just made and click "Revert". Your site goes
back to exactly how it was.
