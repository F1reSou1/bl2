# bl — развёртывание на другом сервере

Проект — Node.js-сервис в Docker. Внутри контейнера он слушает порт `80`; в
примере ниже сайт будет доступен снаружи на порту **1000**:
`http://IP_СЕРВЕРА:1000`.

Для интеграций Bitrix24 нужен постоянный публичный HTTPS-адрес. Порт `1000`
подходит для проверки и внутреннего доступа, но для рабочего сайта лучше
привязать домен и поставить перед контейнером reverse proxy с TLS
(Nginx/Caddy).

## Что понадобится

- сервер с Ubuntu/Debian и открытым TCP-портом `1000`;
- Docker Engine (Docker Compose необязателен: ниже используются обычные
  команды Docker);
- доступ к репозиторию GitHub;
- значения переменных Bitrix24 из текущего сервера/Dokploy. Секретные URL и
  ключи нельзя передавать в Git и нельзя вставлять в этот README.

## 1. Установить Docker

На чистом Ubuntu удобнее установить Docker по [официальной инструкции](https://docs.docker.com/engine/install/ubuntu/).
После установки проверьте:

```bash
docker --version
```

Пользователю, под которым будет запускаться сервис, можно дать право работать
с Docker без `sudo`:

```bash
sudo usermod -aG docker "$USER"
```

После этой команды нужно заново войти в SSH-сессию.

## 2. Скачать проект

```bash
git clone https://github.com/F1reSou1/bl2.git
cd bl2
mkdir -p data
```

Папка `data` сохраняет состояние очереди менеджеров и связку диалогов Открытой
линии. Её нельзя удалять при обновлении контейнера.

## 3. Настроить переменные

```bash
cp .env.example .env
nano .env
```

Заполните как минимум:

```dotenv
BITRIX_WEBHOOK_URL=https://ваш-портал.bitrix24.ru/rest/ID/СЕКРЕТ
BITRIX_CLIENT_CATEGORY_ID=2
BITRIX_RECRUITMENT_CATEGORY_ID=4
BITRIX_CALCULATOR_CATALOG_ID=24
PUBLIC_SITE_URL=https://ваш-домен.example
```

Остальные поля перенесите из старого окружения. Это особенно важно для
`BITRIX_MANAGER_IDS`, полей `UF_CRM_*` и параметров Открытой линии
`BITRIX_OPENLINE_*`. Если каталог товаров читает отдельный вебхук, добавьте
также `BITRIX_CATALOG_WEBHOOK_URL`; иначе будет использован
`BITRIX_WEBHOOK_URL`.

Для запуска только на IP и порту 1000 можно временно указать:

```dotenv
PUBLIC_SITE_URL=http://IP_СЕРВЕРА:1000
```

Но с таким адресом не настраивайте и не переносите локальные приложения
Bitrix24: для них используйте домен с HTTPS.

## 4. Собрать и запустить на порту 1000

```bash
docker build --pull -t bl2:latest .
docker run -d \
  --name bl2 \
  --restart unless-stopped \
  --env-file .env \
  -p 1000:80 \
  -v "$(pwd)/data:/app/data" \
  bl2:latest
```

Файл `.dockerignore` исключает `.env` из образа: секреты передаются контейнеру
только через `--env-file`.

Если на сервере используется UFW, откройте порт:

```bash
sudo ufw allow 1000/tcp
```

## 5. Проверить работу

На сервере:

```bash
docker ps
docker logs --tail 100 bl2
curl -I http://127.0.0.1:1000/
```

С компьютера откройте `http://IP_СЕРВЕРА:1000`. После проверки формы сайта
отправьте тестовую заявку и убедитесь, что в Bitrix24 появились контакт и
сделка.

## 6. Перенос Bitrix24-приложений на новый домен

После появления HTTPS-домена укажите его в `PUBLIC_SITE_URL`, пересоберите
контейнер по инструкции ниже и заново откройте страницу установки чек-листа:

```text
https://ваш-домен.example/api/bitrix/shift-checklist/install
```

Она перепривяжет вкладку «Чек-лист смены» в предложении к новому адресу:

```text
https://ваш-домен.example/api/bitrix/shift-checklist/widget
```

Если в Bitrix24 у локального приложения задан стартовый URL, замените там
старый домен на новый HTTPS-домен. Аналогично обновите callback URL Открытой
линии, если она включена. До этого старый сервер не выключайте — иначе
приложение и чат потеряют доступность.

## Обновление версии

```bash
cd ~/bl2
git pull --ff-only
docker build --pull -t bl2:latest .
docker rm -f bl2
docker run -d \
  --name bl2 \
  --restart unless-stopped \
  --env-file .env \
  -p 1000:80 \
  -v "$(pwd)/data:/app/data" \
  bl2:latest
```

После обновления проверьте `docker logs --tail 100 bl2`. Команда `docker rm -f`
удаляет только контейнер; образ, файл `.env` и папка `data` остаются на месте.

## Полезные команды

```bash
docker logs -f bl2          # смотреть журнал в реальном времени
docker restart bl2          # перезапустить сервис
docker stop bl2             # остановить сервис
docker start bl2            # запустить снова
docker exec -it bl2 sh      # открыть shell внутри контейнера
```
