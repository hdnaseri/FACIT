"""
برنامه‌ی گرافیکی تلفظ طبیعی کلمات دانمارکی و انگلیسی (برای ویندوز)
با صدای نورال مایکروسافت Edge TTS - رایگان و بدون نیاز به اینترنت پرسرعت

=========================
نصب (فقط یک‌بار):
=========================
۱. پایتون رو از python.org نصب کن (موقع نصب تیک "Add Python to PATH" رو بزن)
۲. در Command Prompt (یا PowerShell) این خط رو بزن:

    pip install edge-tts playsound==1.2.2

=========================
اجرا:
=========================
روی فایل pronounce_gui.py دوبار کلیک کن
یا در ترمینال بنویس:

    python pronounce_gui.py
"""

import asyncio
import os
import tempfile
import threading
import tkinter as tk
from tkinter import ttk, messagebox

import edge_tts
from playsound import playsound

# -------------------- صداهای طبیعی --------------------
VOICES = {
    "دانمارکی - زن (Christel)": "da-DK-ChristelNeural",
    "دانمارکی - مرد (Jeppe)": "da-DK-JeppeNeural",
    "انگلیسی آمریکایی - زن (Ava)": "en-US-AvaMultilingualNeural",
    "انگلیسی آمریکایی - مرد (Andrew)": "en-US-AndrewMultilingualNeural",
    "انگلیسی بریتانیایی - زن (Sonia)": "en-GB-SoniaNeural",
    "انگلیسی بریتانیایی - مرد (Ryan)": "en-GB-RyanNeural",
}

HISTORY_FILE = os.path.join(tempfile.gettempdir(), "pronounce_history.txt")


class PronounceApp:
    def __init__(self, root):
        self.root = root
        root.title("تلفظ طبیعی - دانمارکی / انگلیسی")
        root.geometry("520x480")
        root.minsize(460, 420)

        style = ttk.Style()
        try:
            style.theme_use("vista")
        except Exception:
            pass

        main = ttk.Frame(root, padding=16)
        main.pack(fill="both", expand=True)

        ttk.Label(main, text="کلمه یا جمله را وارد کن:", font=("Segoe UI", 11)).pack(anchor="e", fill="x")

        self.text_entry = tk.Text(main, height=4, font=("Segoe UI", 13), wrap="word")
        self.text_entry.pack(fill="x", pady=(6, 14))
        self.text_entry.focus()
        self.text_entry.bind("<Return>", self._on_enter)

        ttk.Label(main, text="صدا:", font=("Segoe UI", 11)).pack(anchor="e", fill="x")
        self.voice_var = tk.StringVar(value=list(VOICES.keys())[0])
        self.voice_combo = ttk.Combobox(
            main, textvariable=self.voice_var, values=list(VOICES.keys()),
            state="readonly", font=("Segoe UI", 11)
        )
        self.voice_combo.pack(fill="x", pady=(4, 14))

        ttk.Label(main, text="سرعت تلفظ:", font=("Segoe UI", 11)).pack(anchor="e", fill="x")
        self.rate_var = tk.IntVar(value=0)
        rate_frame = ttk.Frame(main)
        rate_frame.pack(fill="x", pady=(4, 14))
        self.rate_label = ttk.Label(rate_frame, text="عادی (0%)", font=("Segoe UI", 9))
        self.rate_label.pack(side="right", padx=(8, 0))
        self.rate_scale = ttk.Scale(
            rate_frame, from_=-50, to=20, orient="horizontal",
            variable=self.rate_var, command=self._update_rate_label
        )
        self.rate_scale.pack(side="right", fill="x", expand=True)

        btn_frame = ttk.Frame(main)
        btn_frame.pack(fill="x", pady=(6, 14))
        self.play_btn = ttk.Button(btn_frame, text="🔊 پخش (Enter)", command=self._on_enter)
        self.play_btn.pack(fill="x")

        ttk.Label(main, text="تاریخچه (دوبار کلیک برای پخش دوباره):", font=("Segoe UI", 10)).pack(anchor="e", fill="x")
        self.history_list = tk.Listbox(main, font=("Segoe UI", 11), height=8)
        self.history_list.pack(fill="both", expand=True, pady=(4, 0))
        self.history_list.bind("<Double-Button-1>", self._replay_history)

        self.status_var = tk.StringVar(value="آماده")
        ttk.Label(main, textvariable=self.status_var, font=("Segoe UI", 9), foreground="gray").pack(anchor="w", pady=(8, 0))

        self._load_history()

    def _update_rate_label(self, _evt=None):
        val = int(self.rate_var.get())
        sign = "+" if val >= 0 else ""
        self.rate_label.config(text=f"{sign}{val}%")

    def _on_enter(self, _evt=None):
        text = self.text_entry.get("1.0", "end").strip()
        if not text:
            return
        voice_name = self.voice_var.get()
        voice_id = VOICES[voice_name]
        rate = int(self.rate_var.get())
        rate_str = f"{'+' if rate >= 0 else ''}{rate}%"

        self.play_btn.config(state="disabled")
        self.status_var.set("در حال تولید صدا...")

        thread = threading.Thread(target=self._speak_thread, args=(text, voice_id, rate_str, voice_name))
        thread.daemon = True
        thread.start()

    def _speak_thread(self, text, voice_id, rate_str, voice_name):
        try:
            asyncio.run(self._speak(text, voice_id, rate_str))
            self.root.after(0, lambda: self._on_done(text, voice_name))
        except Exception as e:
            self.root.after(0, lambda: self._on_error(str(e)))

    async def _speak(self, text, voice_id, rate_str):
        with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as tmp:
            out_path = tmp.name
        communicate = edge_tts.Communicate(text, voice_id, rate=rate_str)
        await communicate.save(out_path)

        # playsound مسدودکننده است، پس در یک ترد جدا اجرا می‌کنیم تا رابط کاربری قفل نشود
        await asyncio.to_thread(playsound, out_path)

        try:
            os.remove(out_path)
        except OSError:
            pass

    def _on_done(self, text, voice_name):
        self.status_var.set("آماده")
        self.play_btn.config(state="normal")
        entry = f"{text}    [{voice_name}]"
        if entry not in self.history_list.get(0, "end"):
            self.history_list.insert(0, entry)
            self._save_history()

    def _on_error(self, msg):
        self.status_var.set("خطا")
        self.play_btn.config(state="normal")
        messagebox.showerror("خطا", f"مشکلی پیش آمد:\n{msg}\n\nاینترنت را بررسی کن.")

    def _replay_history(self, _evt=None):
        sel = self.history_list.curselection()
        if not sel:
            return
        entry = self.history_list.get(sel[0])
        text = entry.split("    [")[0]
        self.text_entry.delete("1.0", "end")
        self.text_entry.insert("1.0", text)
        self._on_enter()

    def _save_history(self):
        try:
            items = self.history_list.get(0, "end")[:50]
            with open(HISTORY_FILE, "w", encoding="utf-8") as f:
                f.write("\n".join(items))
        except OSError:
            pass

    def _load_history(self):
        try:
            if os.path.exists(HISTORY_FILE):
                with open(HISTORY_FILE, "r", encoding="utf-8") as f:
                    for line in f.read().splitlines():
                        if line.strip():
                            self.history_list.insert("end", line)
        except OSError:
            pass


if __name__ == "__main__":
    root = tk.Tk()
    app = PronounceApp(root)
    root.mainloop()
