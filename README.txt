Proximity Mic - วิธีใช้

1) ติดตั้ง Node.js (v18+) แล้วเปิดโฟลเดอร์นี้ในเทอร์มินัล
   npm install
   npm start

2) Windows: เปิด PowerShell แบบ Admin แล้วรัน
   CheckNetIsolation LoopbackExempt -a -n="Microsoft.MinecraftUWP_8wekyb3d8bbwe"

3) นำเข้า Mic.mcaddon แล้วเปิดโลกพร้อม Cheats และ Beta APIs (ถ้าเกมถาม)
4) ในเกมพิมพ์ /connect localhost:3000 และ /give @s mic:microphone
5) ทุกคนเปิดเว็บ http://localhost:3000 พิมพ์ !link ในแชตเกม กรอกรหัส 6 หลัก แล้วอนุญาตไมค์

หมายเหตุ: ผู้เล่นนอกเครือข่ายเดียวกันต้องใช้ HTTPS/WSS tunnel; อาจต้องตั้ง TURN server สำหรับการเชื่อมต่อ WebRTC ข้ามเครือข่าย

Vercel ไม่รองรับ WebSocket server: deploy เฉพาะ public/ ไป Vercel และรัน server.js แยกบนเครื่องโฮสต์ จากนั้นเปิด Cloudflare Tunnel แล้วเปิดเว็บด้วย ?server=<tunnel-host>.
