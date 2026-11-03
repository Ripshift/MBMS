scoreboard objectives add boi_amb dummy boi_amb
scoreboard players add @a boi_amb 1
execute @e[scores={boi_amb=101..30000}] ~~~ scoreboard players set @s boi_amb 0

execute @e[scores={boi_amb=100..30000}] ~~~ function ambient_sound_spawn