# Máy chủ thông báo · Giáo Án Địa Ngục

Gửi thông báo tới app đã ghim trên màn hình chính (iPhone iOS 16.4 trở lên, Android, máy tính):
hết giờ nghỉ giữa set, nhắc lịch tập, nhắc cuối tuần, và báo khi HLV / học viên có dữ liệu mới qua Google Drive.

Chạy trên **Cloudflare Workers, gói miễn phí**. Chỉ HLV làm 1 lần; học viên quét mã liên kết Drive là tự có địa chỉ máy chủ.
Khoá bảo mật (VAPID) tự tạo ở lần chạy đầu, không cần điền gì.

## Cách 1 · Bấm nút (dễ nhất)
1. Tạo tài khoản miễn phí ở https://dash.cloudflare.com/sign-up (nếu chưa có).
2. Mở link:
   https://deploy.workers.cloudflare.com/?url=https://github.com/hoangtourguide0507-create/giao-an-dia-nguc/tree/main/push-server
3. Đăng nhập GitHub và Cloudflare khi được hỏi → **Deploy**. Giữ tên `gadn-push`.
4. Xong, Cloudflare hiện địa chỉ dạng `https://gadn-push.<tên-của-bạn>.workers.dev`. Chép địa chỉ này.

## Cách 2 · Dùng Terminal trên Mac
```bash
cd ~/Desktop/GiaoAnDiaNguc-ThongBao      # thư mục chứa wrangler.toml
npx wrangler login                        # mở trình duyệt để đăng nhập Cloudflare
npx wrangler deploy
```
Cuối cùng Terminal in ra địa chỉ `https://gadn-push.<tên>.workers.dev`.

## Đặt khoá HLV (bắt buộc để đồng bộ hoạt động) · PA-33
Máy chủ không có lệnh "tạo HLV": chỉ ai có **QR HLV** mới là HLV. Máy chủ chỉ giữ **băm** của khoá trong QR,
không giữ khoá gốc. Sau khi deploy, chạy trong thư mục `push-server/` (cần đăng nhập `npx wrangler login`):
```bash
npx wrangler secret put HLV_HASH
# dán chuỗi băm của QR HLV (43 ký tự), rồi Enter
```
Chưa đặt `HLV_HASH` thì mọi lệnh đồng bộ đều bị từ chối (401): an toàn, không ai vào được.
Mất QR: sinh QR mới ngoài repo, đặt lại `HLV_HASH` bằng lệnh trên. Dữ liệu trên máy chủ không mất.
Dữ liệu đồng bộ nằm trong Durable Object `Hub` (SQLite), không cần tạo bảng tay.

## Kiểm tra
Mở địa chỉ trên trình duyệt → thấy `{"ok":true,"ten":"Giáo Án Địa Ngục · máy chủ thông báo"}` là chạy.

## Nhập vào app (máy HLV)
1. Mở app từ icon trên màn hình chính → tab **Cài đặt** → thẻ **Thông báo của app**.
2. Dán địa chỉ vào ô **Máy chủ thông báo** → **Bật thông báo** → cho phép.
3. Bấm **Gửi thử ngay**: vài giây sau có thông báo là thành công.
4. Chọn ngày giờ nhắc tập, cách báo hết giờ nghỉ (Thông báo app / Phím tắt iPhone).

Học viên: sau khi quét **mã liên kết Drive** (tạo sau khi đã nhập máy chủ thông báo), vào Cài đặt → **Bật thông báo**.
Nếu học viên đã liên kết từ trước, HLV bấm **☁ Drive → Gửi mã qua Zalo** lại để mã mới có kèm địa chỉ máy chủ, hoặc học viên tự dán địa chỉ vào ô Máy chủ thông báo.

## Giới hạn
- iPhone chỉ nhận thông báo khi app được mở từ icon trên màn hình chính.
- Gói miễn phí của Cloudflare dư cho vài chục người dùng hằng ngày.
