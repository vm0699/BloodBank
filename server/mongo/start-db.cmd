@echo off
rem LifeLink's OWN MongoDB process. Separate port, separate data folder, login required.
rem It does not touch any other MongoDB on this PC (that one uses port 27017).
rem   data : server\mongo\data      log : server\mongo\log\mongod.log      port : 27418 (127.0.0.1 only)
setlocal
set "MONGOD=%MONGOD_BIN%"
if not defined MONGOD for /d %%D in ("%ProgramFiles%\MongoDB\Server\*") do if exist "%%D\bin\mongod.exe" set "MONGOD=%%D\bin\mongod.exe"
if not defined MONGOD (echo mongod.exe not found. Set MONGOD_BIN to its full path. & exit /b 1)
if not exist "%~dp0data" mkdir "%~dp0data"
if not exist "%~dp0log" mkdir "%~dp0log"
echo Starting LifeLink database on 127.0.0.1:27418  (data: %~dp0data)
"%MONGOD%" --dbpath "%~dp0data" --port 27418 --bind_ip 127.0.0.1 --auth --logpath "%~dp0log\mongod.log" --logappend
