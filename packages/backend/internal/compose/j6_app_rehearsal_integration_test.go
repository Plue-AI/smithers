package compose

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

// Chromium uses the mounted command/card and its real terminal stream, with
// the GitHub-authenticated browser cookies from setup. No intercepted routes.
func (r *rehearsal) appTerminalRow(t1 int64) {
	r.step("3 App terminal door", "app /todo T1; /terminal branch; TerminalCard keyboard input", "mounted terminal prints ok from the real guest", "T-APP-12", func() error {
		if os.Getenv("SMITHERS_REHEARSAL_SPA_DIR") == "" {
			return fmt.Errorf("row 3 requires SMITHERS_REHEARSAL_SPA_DIR pointing to the built install app")
		}
		todo, err := r.todo(t1)
		if err != nil {
			return err
		}
		if todo.Branch == nil {
			return fmt.Errorf("T1 has no branch")
		}
		cookies := []map[string]any{}
		for _, cookie := range r.jar.Cookies(mustRehearsalURL(r.origin)) {
			cookies = append(cookies, map[string]any{"name": cookie.Name, "value": cookie.Value, "url": r.origin})
		}
		payload, _ := json.Marshal(map[string]any{"origin": r.origin, "cookies": cookies, "todo": t1, "branch": todo.Branch.Name, "screenshot": filepath.Join(r.evidence, "app-terminal.png")})
		script := `const {chromium}=require('@playwright/test');
(async()=>{const fixture=JSON.parse(process.env.J6_BROWSER_FIXTURE);const browser=await chromium.launch({headless:true});try{
 const context=await browser.newContext();await context.addCookies(fixture.cookies);const page=await context.newPage();let output='';
 page.on('websocket',socket=>{if(socket.url().includes('/terminal'))socket.on('framereceived',frame=>{output+=frame.payload.toString()})});
 await page.goto(fixture.origin);
 const command=async text=>{const composer=page.getByTestId('composer-input');if(!await composer.isVisible())await page.keyboard.press('ControlOrMeta+k');await composer.fill(text);await composer.press('Enter')};
 await command('/todo T'+fixture.todo);await page.getByTestId('composer-input').waitFor({state:'visible'});
 await command('/terminal '+fixture.branch);
 const terminal=page.locator('.terminal-view').last();await terminal.waitFor({state:'visible',timeout:120000});const slot=terminal.locator('.terminal-output > div');if(await slot.getAttribute('inert')!==null)throw new Error('terminal is watching or frozen');await slot.locator('.xterm-helper-textarea').focus();
 const start=output.length;await page.keyboard.type('echo J6""APP ok');await page.keyboard.press('Enter');
 const deadline=Date.now()+30000;while(!/J6APP ok/.test(output.slice(start))){if(Date.now()>deadline)throw new Error('guest did not print ok');await new Promise(resolve=>setTimeout(resolve,100))}
 await page.screenshot({path:fixture.screenshot});console.log('mounted terminal printed ok');
 }finally{await browser.close()}})().catch(error=>{console.error(error);process.exitCode=1});`
		ctx, cancel := context.WithTimeout(r.ctx, 4*time.Minute)
		defer cancel()
		cmd := exec.CommandContext(ctx, "node", "-e", script)
		cmd.Dir = filepath.Join(r.root, "apps/app")
		cmd.Env = append(os.Environ(), "J6_BROWSER_FIXTURE="+string(payload))
		output, err := cmd.CombinedOutput()
		r.actual = string(output)
		if err != nil {
			return fmt.Errorf("app terminal: %w: %s", err, output)
		}
		return nil
	})
}
