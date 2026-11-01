execute @p ~~~ tp @e[type=boi:function_master,c=1] ^^3^-1
tag @e[type=boi:function_master_spawn] add despawn

function addon_function1
function addon_function2
function addon_function3
function addon_function4
function addon_function5
function addon_function6
function addon_function7
function addon_function8
function addon_function9
function addon_function10

function addon_function11
function addon_function12
function addon_function13
function addon_function14
function addon_function15
function addon_function16
function addon_function17
function addon_function18
function addon_function19
function addon_function20

function addon_function21
function addon_function22
function addon_function23
function addon_function24
function addon_function25
function addon_function26
function addon_function27
function addon_function28
function addon_function29
function addon_function30

function addon_function31
function addon_function32
function addon_function33
function addon_function34
function addon_function35
function addon_function36
function addon_function37
function addon_function38
function addon_function39
function addon_function40

scoreboard objectives add second dummy second
scoreboard players add @p second 1
execute @e[scores={second=15..30000}] ~~~ scoreboard players set @s second 0

scoreboard objectives add age dummy age
scoreboard players add @s age 1
execute @e[scores={age=24..30000}] ~~~ tag @e[scores={age=1..23}] add despawn
execute @e[scores={age=25..30000}] ~~~ scoreboard players set @s age 0







scoreboard objectives add player_num dummy player_num
execute @a ~~~ scoreboard players add @e[type=boi:function_master] player_num 1


execute @e[scores={player_num=1..1}] ~~~ tag @s add 1player
execute @e[scores={player_num=1..1}] ~~~ tag @s remove 2player
execute @e[scores={player_num=1..1}] ~~~ tag @s remove 3player
execute @e[scores={player_num=1..1}] ~~~ tag @s remove 4player
execute @e[scores={player_num=1..1}] ~~~ tag @s remove manyplayer
execute @e[scores={player_num=1..1}] ~~~ scoreboard players set @s player_num 0

execute @e[scores={player_num=2..2}] ~~~ tag @s remove 1player
execute @e[scores={player_num=2..2}] ~~~ tag @s add 2player
execute @e[scores={player_num=2..2}] ~~~ tag @s remove 3player
execute @e[scores={player_num=2..2}] ~~~ tag @s remove 4player
execute @e[scores={player_num=2..2}] ~~~ tag @s add manyplayer
execute @e[scores={player_num=2..2}] ~~~ scoreboard players set @s player_num 0

execute @e[scores={player_num=3..3}] ~~~ tag @s remove 1player
execute @e[scores={player_num=3..3}] ~~~ tag @s remove 2player
execute @e[scores={player_num=3..3}] ~~~ tag @s add 3player
execute @e[scores={player_num=3..3}] ~~~ tag @s remove 4player
execute @e[scores={player_num=3..3}] ~~~ tag @s add manyplayer
execute @e[scores={player_num=3..3}] ~~~ scoreboard players set @s player_num 0

execute @e[scores={player_num=4..4}] ~~~ tag @s remove 1player
execute @e[scores={player_num=4..4}] ~~~ tag @s remove 2player
execute @e[scores={player_num=4..4}] ~~~ tag @s remove 3player
execute @e[scores={player_num=4..4}] ~~~ tag @s add 4player
execute @e[scores={player_num=4..4}] ~~~ tag @s add manyplayer
execute @e[scores={player_num=4..4}] ~~~ scoreboard players set @s player_num 0

execute @e[scores={player_num=5..5}] ~~~ tag @s remove 1player
execute @e[scores={player_num=5..5}] ~~~ tag @s remove 2player
execute @e[scores={player_num=5..5}] ~~~ tag @s remove 3player
execute @e[scores={player_num=5..5}] ~~~ tag @s remove 4player
execute @e[scores={player_num=5..5}] ~~~ tag @s add manyplayer
execute @e[scores={player_num=5..50000}] ~~~ scoreboard players set @s player_num 0
